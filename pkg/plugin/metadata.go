package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
	"github.com/jackc/pgx/v5"
)

// ColumnInfo describes one column parsed from a KWDB SHOW CREATE TABLE result.
type ColumnInfo struct {
	Name         string `json:"name"`
	Type         string `json:"type"`
	IsTag        bool   `json:"isTag"`
	IsTimeColumn bool   `json:"isTimeColumn"`
	IsPrimaryTag bool   `json:"isPrimaryTag"`
}

// TableInfo describes one table returned by SHOW TABLES.
type TableInfo struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type rowQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

type metadataHandler struct {
	querier  rowQuerier
	database string
}

func newMetadataHandler(querier rowQuerier, database string) backend.CallResourceHandler {
	mux := http.NewServeMux()
	h := &metadataHandler{querier: querier, database: database}
	mux.HandleFunc("/tables", h.handleTables)
	mux.HandleFunc("/columns", h.handleColumns)
	mux.HandleFunc("/tag-values", h.handleTagValues)
	return httpadapter.New(mux)
}

func (h *metadataHandler) handleTables(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	rows, err := h.querier.Query(r.Context(), fmt.Sprintf("SHOW TABLES FROM %s", quoteIdent(h.database)))
	if err != nil {
		http.Error(w, sanitizeError(err), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var tables []TableInfo
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			http.Error(w, sanitizeError(err), http.StatusInternalServerError)
			return
		}
		if len(values) > 0 {
			info := TableInfo{Name: fmt.Sprint(values[0])}
			if len(values) > 1 {
				info.Type = fmt.Sprint(values[1])
			}
			tables = append(tables, info)
		}
	}
	if err := rows.Err(); err != nil {
		http.Error(w, sanitizeError(err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, tables)
}

func (h *metadataHandler) handleColumns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	table := r.URL.Query().Get("table")
	if table == "" {
		http.Error(w, "missing table query parameter", http.StatusBadRequest)
		return
	}

	infos, err := h.loadTableColumns(r.Context(), table)
	if err != nil {
		http.Error(w, sanitizeError(err), http.StatusInternalServerError)
		return
	}
	if infos == nil {
		infos = []ColumnInfo{}
	}
	writeJSON(w, infos)
}

// loadTableColumns reads SHOW CREATE TABLE output for the given table and returns the parsed
// column metadata. It is shared by /columns and /tag-values.
func (h *metadataHandler) loadTableColumns(ctx context.Context, table string) ([]ColumnInfo, error) {
	rows, err := h.querier.Query(ctx, fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteIdent(h.database), quoteIdent(table)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ddl := ""
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		for _, v := range values {
			if s, ok := v.(string); ok && strings.Contains(strings.ToUpper(s), "CREATE TABLE") {
				ddl = s
				break
			}
		}
		if ddl != "" {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if ddl == "" {
		return nil, fmt.Errorf("could not read SHOW CREATE TABLE output")
	}
	return parseDDL(ddl), nil
}

func (h *metadataHandler) handleTagValues(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}

	table := r.URL.Query().Get("table")
	if table == "" {
		http.Error(w, "missing table query parameter", http.StatusBadRequest)
		return
	}
	column := r.URL.Query().Get("column")
	if column == "" {
		http.Error(w, "missing column query parameter", http.StatusBadRequest)
		return
	}

	infos, err := h.loadTableColumns(r.Context(), table)
	if err != nil {
		http.Error(w, sanitizeError(err), http.StatusInternalServerError)
		return
	}
	isTag := false
	for _, info := range infos {
		if info.Name == column && info.IsTag {
			isTag = true
			break
		}
	}
	if !isTag {
		http.Error(w, fmt.Sprintf("column %q of table %q is not a tag column", column, table), http.StatusBadRequest)
		return
	}

	sql := fmt.Sprintf(
		"SELECT DISTINCT %s FROM %s.%s ORDER BY %s LIMIT %d",
		quoteIdent(column), quoteIdent(h.database), quoteIdent(table), quoteIdent(column), tagValuesLimit,
	)
	rows, err := h.querier.Query(r.Context(), sql)
	if err != nil {
		http.Error(w, sanitizeError(err), http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	values := []string{}
	for rows.Next() {
		row, err := rows.Values()
		if err != nil {
			http.Error(w, sanitizeError(err), http.StatusInternalServerError)
			return
		}
		if len(row) > 0 && row[0] != nil {
			values = append(values, fmt.Sprint(row[0]))
		}
	}
	if err := rows.Err(); err != nil {
		http.Error(w, sanitizeError(err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, values)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		http.Error(w, sanitizeError(err), http.StatusInternalServerError)
	}
}

func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// tagValuesLimit bounds the number of distinct tag values returned for a
// template variable so a high-cardinality tag cannot exhaust plugin memory.
const tagValuesLimit = 10000

// tableConstraintKeywords are DDL clauses that start with an unquoted keyword
// and must not be mistaken for column definitions.
var tableConstraintKeywords = map[string]struct{}{
	"CHECK":      {},
	"CONSTRAINT": {},
	"EXCLUDE":    {},
	"FAMILY":     {},
	"FOREIGN":    {},
	"INDEX":      {},
	"INDEXES":    {},
	"INVERTED":   {},
	"KEY":        {},
	"LIKE":       {},
	"PERIOD":     {},
	"PRIMARY":    {},
	"UNIQUE":     {},
}

func isTableConstraintKeyword(word string) bool {
	_, ok := tableConstraintKeywords[strings.ToUpper(word)]
	return ok
}

type columnDef struct {
	name string
	typ  string
}

var (
	columnDefRe   = regexp.MustCompile(`(?i)^\s*(?:"((?:[^"]|"")*)"|([^\s,()]+))\s+([A-Za-z][A-Za-z0-9_]*)(\s*\([^)]*\))?(?:\s+([A-Za-z][A-Za-z0-9_]*))?`)
	primaryTagsRe = regexp.MustCompile(`(?i)\bPRIMARY\s+TAGS\s*\(([^)]*)\)`)
)

func parseDDL(ddl string) []ColumnInfo {
	dataCols, tagCols, primaryTags := parseCreateTable(ddl)
	if len(dataCols) == 0 {
		return nil
	}

	tagByName := make(map[string]columnDef, len(tagCols))
	for _, tag := range tagCols {
		tagByName[tag.name] = tag
	}

	infos := make([]ColumnInfo, 0, len(dataCols)+len(tagCols))
	seen := make(map[string]bool, len(dataCols)+len(tagCols))
	for _, col := range dataCols {
		info := ColumnInfo{
			Name:         col.name,
			Type:         col.typ,
			IsTimeColumn: isTimeColumn(col.name, col.typ),
		}
		if tag, ok := tagByName[col.name]; ok {
			info.IsTag = true
			info.Type = tag.typ
		}
		infos = append(infos, info)
		seen[col.name] = true
	}
	for _, tag := range tagCols {
		if seen[tag.name] {
			continue
		}
		infos = append(infos, ColumnInfo{
			Name:         tag.name,
			Type:         tag.typ,
			IsTag:        true,
			IsTimeColumn: isTimeColumn(tag.name, tag.typ),
		})
		seen[tag.name] = true
	}
	for i := range infos {
		if containsFold(primaryTags, infos[i].Name) {
			infos[i].IsPrimaryTag = true
		}
	}
	return infos
}

func parseCreateTable(ddl string) (dataCols, tagCols []columnDef, primaryTags []string) {
	open := strings.IndexByte(ddl, '(')
	if open < 0 {
		return nil, nil, nil
	}
	closeIdx := findMatchingParen(ddl, open)
	if closeIdx < 0 {
		return nil, nil, nil
	}
	dataCols = parseColumnDefs(ddl[open+1 : closeIdx])

	rest := ddl[closeIdx+1:]
	if tagsOpen := findTagsClause(rest); tagsOpen >= 0 {
		if tagsClose := findMatchingParen(rest, tagsOpen); tagsClose >= 0 {
			tagCols = parseColumnDefs(rest[tagsOpen+1 : tagsClose])
		}
	}
	if match := primaryTagsRe.FindStringSubmatch(rest); match != nil {
		primaryTags = parseIdentifiers(match[1])
	}
	return dataCols, tagCols, primaryTags
}

func parseColumnDefs(body string) []columnDef {
	var cols []columnDef
	for _, segment := range splitTopLevel(body, ',') {
		if col, ok := parseColumnDef(segment); ok {
			cols = append(cols, col)
		}
	}
	return cols
}

func parseColumnDef(segment string) (columnDef, bool) {
	match := columnDefRe.FindStringSubmatch(segment)
	if match == nil {
		return columnDef{}, false
	}
	name := match[1]
	if name == "" {
		// Unquoted identifiers can be table-level clauses such as
		// "INDEX ix (col)" or "FOREIGN KEY (col) REFERENCES ...", which the
		// column regex would otherwise turn into phantom columns.
		if isTableConstraintKeyword(match[2]) {
			return columnDef{}, false
		}
		name = match[2]
	}
	name = strings.ReplaceAll(name, `""`, `"`)

	typ := strings.ToUpper(match[3] + match[4])
	if match[5] != "" {
		switch strings.ToUpper(match[3]) {
		case "DOUBLE", "CHARACTER":
			typ += " " + strings.ToUpper(match[5])
		}
	}
	return columnDef{name: name, typ: typ}, true
}

func isTimeColumn(name, typ string) bool {
	lowerName := strings.ToLower(name)
	switch lowerName {
	case "time", "ts", "k_timestamp", "timestamp":
		return true
	}
	lowerType := strings.ToLower(typ)
	return strings.HasPrefix(lowerType, "timestamp") || strings.HasPrefix(lowerType, "time(")
}

func parseIdentifiers(s string) []string {
	var ids []string
	for _, part := range splitTopLevel(s, ',') {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if strings.HasPrefix(part, `"`) && strings.HasSuffix(part, `"`) && len(part) >= 2 {
			part = strings.ReplaceAll(part[1:len(part)-1], `""`, `"`)
		}
		ids = append(ids, part)
	}
	return ids
}

func findTagsClause(rest string) int {
	upper := strings.ToUpper(rest)
	offset := 0
	for {
		idx := strings.Index(upper[offset:], "TAGS")
		if idx < 0 {
			return -1
		}
		start := offset + idx
		prefix := strings.TrimRight(rest[:start], " \t\r\n")
		if strings.HasSuffix(strings.ToUpper(prefix), "PRIMARY") {
			offset = start + len("TAGS")
			continue
		}
		after := strings.TrimLeft(rest[start+len("TAGS"):], " \t\r\n")
		if strings.HasPrefix(after, "(") {
			return start + len("TAGS") + len(rest[start+len("TAGS"):]) - len(after)
		}
		offset = start + len("TAGS")
	}
}

func findMatchingParen(s string, open int) int {
	depth := 0
	inSingle := false
	inDouble := false
	for i := open; i < len(s); i++ {
		c := s[i]
		switch {
		case inSingle:
			if c == '\'' {
				inSingle = false
			}
		case inDouble:
			if c == '"' {
				if i+1 < len(s) && s[i+1] == '"' {
					i++
				} else {
					inDouble = false
				}
			}
		default:
			switch c {
			case '\'':
				inSingle = true
			case '"':
				inDouble = true
			case '(':
				depth++
			case ')':
				depth--
				if depth == 0 {
					return i
				}
			}
		}
	}
	return -1
}

func splitTopLevel(s string, sep byte) []string {
	var parts []string
	depth := 0
	inSingle := false
	inDouble := false
	start := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case inSingle:
			if c == '\'' {
				inSingle = false
			}
		case inDouble:
			if c == '"' {
				if i+1 < len(s) && s[i+1] == '"' {
					i++
				} else {
					inDouble = false
				}
			}
		default:
			switch c {
			case '\'':
				inSingle = true
			case '"':
				inDouble = true
			case '(':
				depth++
			case ')':
				depth--
			case sep:
				if depth == 0 {
					parts = append(parts, strings.TrimSpace(s[start:i]))
					start = i + 1
				}
			}
		}
	}
	parts = append(parts, strings.TrimSpace(s[start:]))
	return parts
}
