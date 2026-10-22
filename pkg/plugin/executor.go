package plugin

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var leadingCommentRe = regexp.MustCompile(`(?s)^\s*(?:--[^\n]*(?:\n|$)|\/\*.*?\*\/)`)

// writeKeywords lists statement/DML keywords that must never appear outside
// string literals, quoted identifiers and comments.
var writeKeywords = map[string]struct{}{
	"ALTER":    {},
	"CALL":     {},
	"COMMENT":  {},
	"COPY":     {},
	"CREATE":   {},
	"DELETE":   {},
	"DISCARD":  {},
	"DO":       {},
	"DROP":     {},
	"GRANT":    {},
	"INSERT":   {},
	"INTO":     {},
	"LOCK":     {},
	"MERGE":    {},
	"REFRESH":  {},
	"REINDEX":  {},
	"REVOKE":   {},
	"TRUNCATE": {},
	"UPDATE":   {},
	"UPSERT":   {},
	"VACUUM":   {},
}

// forbiddenInternalSchemas are internal catalogs that expose management
// functions able to affect the database process itself.
var forbiddenInternalSchemas = map[string]struct{}{
	"crdb_internal": {},
	"kwdb_internal": {},
}

// forbiddenFunctions lists functions with side effects, unbounded blocking,
// server file access or session state mutation (for example disabling the
// statement timeout). The keyword scan cannot see them, so they are rejected by
// name. Names are compared lower case.
var forbiddenFunctions = map[string]struct{}{
	"dblink":                  {},
	"dblink_exec":             {},
	"lo_export":               {},
	"lo_import":               {},
	"nextval":                 {},
	"pg_advisory_lock":        {},
	"pg_advisory_xact_lock":   {},
	"pg_cancel_backend":       {},
	"pg_create_restore_point": {},
	"pg_ls_dir":               {},
	"pg_promote":              {},
	"pg_read_binary_file":     {},
	"pg_read_file":            {},
	"pg_reload_conf":          {},
	"pg_rotate_logfile":       {},
	"pg_sleep":                {},
	"pg_sleep_for":            {},
	"pg_sleep_until":          {},
	"pg_start_backup":         {},
	"pg_stat_file":            {},
	"pg_stop_backup":          {},
	"pg_switch_wal":           {},
	"pg_terminate_backend":    {},
	"pg_wal_replay_pause":     {},
	"pg_wal_replay_resume":    {},
	"set_config":              {},
	"setval":                  {},
}

// forbiddenShowKeywords blocks the SHOW forms that expose cluster or session
// state (other sessions, jobs, traces, backups) instead of schema metadata.
var forbiddenShowKeywords = map[string]struct{}{
	"ALL":         {},
	"BACKUP":      {},
	"CHANGEFEEDS": {},
	"JOBS":        {},
	"QUERIES":     {},
	"SCHEDULES":   {},
	"SESSIONS":    {},
	"STATISTICS":  {},
	"TRACE":       {},
}

// IsReadOnly reports whether the SQL statement is a single read-only statement.
//
// This is a guard rail, not a security boundary: it is a lexical check meant to
// stop accidental writes and obvious mistakes. Production deployments should
// also connect with a read-only account and rely on the connection-level
// default_transaction_read_only setting applied in NewDatasource.
func IsReadOnly(sql string) bool {
	_, ok := scanReadOnly(sql)
	return ok
}

// ReadOnlyViolation returns a human readable reason when the statement is not a
// single allowed read-only statement. It returns an empty string when allowed.
func ReadOnlyViolation(sql string) string {
	reason, ok := scanReadOnly(sql)
	if ok {
		return ""
	}
	return reason
}

func scanReadOnly(sql string) (string, bool) {
	if !isAllowedFirstKeyword(sql) {
		return "only read-only statements (SELECT/SHOW/EXPLAIN/WITH) are allowed", false
	}
	if reason, forbidden := scanForbiddenSQL(sql); forbidden {
		return reason, false
	}
	return "", true
}

func isAllowedFirstKeyword(sql string) bool {
	switch firstKeyword(sql) {
	case "SELECT", "SHOW", "EXPLAIN", "WITH":
		return true
	default:
		return false
	}
}

// firstKeyword returns the upper cased leading keyword of a statement, ignoring
// leading comments and whitespace.
func firstKeyword(sql string) string {
	sql = strings.TrimSpace(stripLeadingComments(sql))
	if sql == "" {
		return ""
	}
	end := strings.IndexFunc(sql, func(r rune) bool {
		return !isIdentRune(r)
	})
	if end < 0 {
		end = len(sql)
	}
	return strings.ToUpper(sql[:end])
}

// scanForbiddenSQL rejects statements that contain a second statement, write
// keywords, internal management catalogs or side-effecting functions outside
// string literals, quoted identifiers and comments.
func scanForbiddenSQL(sql string) (string, bool) {
	wordStart := -1
	// A SHOW statement mentions DDL keywords as its object ("SHOW CREATE
	// TABLE"); those are descriptions, not statements, so the write keyword
	// check does not apply. The SHOW allowlist below still restricts the form.
	checkWriteKeywords := firstKeyword(sql) != "SHOW"

	flushWord := func(end int) (string, bool) {
		if wordStart < 0 {
			return "", false
		}
		word := strings.ToLower(sql[wordStart:end])
		wordStart = -1
		if _, ok := forbiddenInternalSchemas[word]; ok {
			return "internal catalog " + word + " is not allowed", true
		}
		if _, ok := forbiddenFunctions[word]; ok {
			return "function " + word + " is not allowed", true
		}
		if checkWriteKeywords {
			upper := strings.ToUpper(word)
			if _, ok := writeKeywords[upper]; ok {
				return "write keyword " + upper + " is not allowed", true
			}
		}
		return "", false
	}

	for i := 0; i < len(sql); {
		switch c := sql[i]; {
		case c == '\'':
			if reason, bad := flushWord(i); bad {
				return reason, true
			}
			i = skipSingleQuoted(sql, i, isEscapePrefixed(sql, i))
		case c == '"':
			if reason, bad := flushWord(i); bad {
				return reason, true
			}
			i = skipDoubleQuoted(sql, i)
		case c == '$':
			if next, ok := skipDollarQuoted(sql, i); ok {
				if reason, bad := flushWord(i); bad {
					return reason, true
				}
				i = next
				continue
			}
			if reason, bad := flushWord(i); bad {
				return reason, true
			}
			i++
		case c == '-' && i+1 < len(sql) && sql[i+1] == '-':
			if reason, bad := flushWord(i); bad {
				return reason, true
			}
			i = skipLineComment(sql, i)
		case c == '/' && i+1 < len(sql) && sql[i+1] == '*':
			if reason, bad := flushWord(i); bad {
				return reason, true
			}
			i = skipBlockComment(sql, i)
		case c == ';':
			if reason, bad := flushWord(i); bad {
				return reason, true
			}
			if !restIsCommentOrWhitespace(sql[i+1:]) {
				return "multi-statement SQL is not allowed", true
			}
			i++
		case isWordByte(c):
			if wordStart < 0 {
				wordStart = i
			}
			i++
		default:
			if reason, bad := flushWord(i); bad {
				return reason, true
			}
			i++
		}
	}
	if reason, bad := flushWord(len(sql)); bad {
		return reason, true
	}

	return scanShowStatement(sql)
}

// scanShowStatement blocks SHOW forms that expose cluster or session state.
func scanShowStatement(sql string) (string, bool) {
	body := strings.TrimSpace(stripLeadingComments(sql))
	if len(body) < 4 || !strings.EqualFold(body[:4], "SHOW") {
		return "", false
	}
	rest := strings.TrimSpace(stripLeadingComments(body[4:]))
	if rest == "" {
		return "", false
	}
	end := strings.IndexFunc(rest, func(r rune) bool {
		return !isIdentRune(r)
	})
	if end < 0 {
		end = len(rest)
	}
	keyword := strings.ToUpper(rest[:end])
	if _, blocked := forbiddenShowKeywords[keyword]; blocked {
		return "SHOW " + keyword + " is not allowed; it exposes cluster or session state", true
	}
	return "", false
}

func stripLeadingComments(sql string) string {
	for {
		stripped := leadingCommentRe.ReplaceAllString(sql, "")
		if stripped == sql {
			return sql
		}
		sql = stripped
	}
}

// isEscapePrefixed reports whether the single quote at start belongs to an
// E'...' escape string, where a backslash escapes the next character.
func isEscapePrefixed(sql string, start int) bool {
	if start < 1 {
		return false
	}
	if sql[start-1] != 'E' && sql[start-1] != 'e' {
		return false
	}
	return start < 2 || !isWordByte(sql[start-2])
}

func skipSingleQuoted(sql string, start int, escapes bool) int {
	for i := start + 1; i < len(sql); i++ {
		if escapes && sql[i] == '\\' && i+1 < len(sql) {
			i++
			continue
		}
		if sql[i] == '\'' {
			if i+1 < len(sql) && sql[i+1] == '\'' {
				i++
				continue
			}
			return i + 1
		}
	}
	return len(sql)
}

func skipDoubleQuoted(sql string, start int) int {
	for i := start + 1; i < len(sql); i++ {
		if sql[i] == '"' {
			if i+1 < len(sql) && sql[i+1] == '"' {
				i++
				continue
			}
			return i + 1
		}
	}
	return len(sql)
}

// skipDollarQuoted skips PostgreSQL dollar-quoted strings ($tag$...$tag$).
func skipDollarQuoted(sql string, start int) (int, bool) {
	if sql[start] != '$' {
		return start, false
	}
	end := start + 1
	for end < len(sql) && isWordByte(sql[end]) {
		end++
	}
	if end >= len(sql) || sql[end] != '$' {
		return start, false
	}
	tag := sql[start : end+1]
	tagEnd := strings.Index(sql[end+1:], tag)
	if tagEnd < 0 {
		return len(sql), true
	}
	return end + 1 + tagEnd + len(tag), true
}

func skipLineComment(sql string, start int) int {
	for i := start + 2; i < len(sql); i++ {
		if sql[i] == '\n' {
			return i + 1
		}
	}
	return len(sql)
}

// skipBlockComment skips a block comment and supports nesting, which
// PostgreSQL (and KWDB) allow.
func skipBlockComment(sql string, start int) int {
	depth := 1
	for i := start + 2; i+1 < len(sql); i++ {
		switch {
		case sql[i] == '/' && sql[i+1] == '*':
			depth++
			i++
		case sql[i] == '*' && sql[i+1] == '/':
			depth--
			i++
			if depth == 0 {
				return i + 1
			}
		}
	}
	return len(sql)
}

func restIsCommentOrWhitespace(s string) bool {
	for i := 0; i < len(s); {
		switch {
		case s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n':
			i++
		case s[i] == '-' && i+1 < len(s) && s[i+1] == '-':
			i = skipLineComment(s, i)
		case s[i] == '/' && i+1 < len(s) && s[i+1] == '*':
			i = skipBlockComment(s, i)
		default:
			return false
		}
	}
	return true
}

func isWordByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_'
}

func isIdentRune(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_'
}

// ExecuteQuery runs the SQL on the pool and returns the pgx result rows.
func ExecuteQuery(ctx context.Context, pool *pgxpool.Pool, sql string) (pgx.Rows, error) {
	if pool == nil {
		return nil, errors.New("database connection pool is not initialized")
	}
	return pool.Query(ctx, sql)
}
