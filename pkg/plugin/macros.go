package plugin

import (
	"fmt"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const macroTimeFormat = "2006-01-02 15:04:05.999999999"

// ExpandMacros replaces Grafana time macros with KWDB-compatible SQL
// fragments. Time macros are expanded by a paren-matching scanner instead of a
// regular expression so that nested expressions such as
// $__timeFilter(CAST(ts AS TIMESTAMP)) or $__timeFilter(time_bucket(ts, '5m'))
// expand correctly. Every expansion is wrapped in parentheses so surrounding
// boolean operators keep their meaning.
//
// Expansion only happens in executable SQL: a macro that appears inside a
// string literal, a quoted identifier or a comment is left untouched, because
// rewriting it would corrupt that literal. A macro call is consumed as a whole,
// including any literals inside its argument list, so the scanner never splits
// $__timeGroup(ts, '5m') at the '5m'.
func ExpandMacros(rawSql string, timeRange backend.TimeRange) string {
	from := fmt.Sprintf("'%s'::TIMESTAMP", timeRange.From.UTC().Format(macroTimeFormat))
	to := fmt.Sprintf("'%s'::TIMESTAMP", timeRange.To.UTC().Format(macroTimeFormat))

	if !strings.Contains(rawSql, "$__") {
		return rawSql
	}

	var b strings.Builder
	b.Grow(len(rawSql))
	// codeStart marks the beginning of the current run of executable SQL; only
	// those bytes reach the scalar replacement below.
	codeStart := 0
	// Each run of executable SQL is written out with the scalar macros
	// substituted, so a macro inside a literal is never touched.
	writeRun := func(end int) {
		if end <= codeStart {
			return
		}
		code := rawSql[codeStart:end]
		code = strings.ReplaceAll(code, "$__timeFrom", from)
		code = strings.ReplaceAll(code, "$__timeTo", to)
		b.WriteString(code)
	}
	copyVerbatim := func(next int) {
		b.WriteString(rawSql[codeStart:next])
		codeStart = next
	}
	for i := 0; i < len(rawSql); {
		if replacement, next, ok := expandMacroAt(rawSql, i, from, to); ok {
			writeRun(i)
			b.WriteString(replacement)
			i = next
			codeStart = next
			continue
		}
		switch c := rawSql[i]; {
		case c == '\'':
			next := skipSingleQuoted(rawSql, i, isEscapePrefixed(rawSql, i))
			copyVerbatim(next)
			i = next
		case c == '"':
			next := skipDoubleQuoted(rawSql, i)
			copyVerbatim(next)
			i = next
		case c == '$':
			if next, ok := skipDollarQuoted(rawSql, i); ok {
				copyVerbatim(next)
				i = next
				continue
			}
			i++
		case c == '-' && i+1 < len(rawSql) && rawSql[i+1] == '-':
			next := skipLineComment(rawSql, i)
			copyVerbatim(next)
			i = next
		case c == '/' && i+1 < len(rawSql) && rawSql[i+1] == '*':
			next := skipBlockComment(rawSql, i)
			copyVerbatim(next)
			i = next
		default:
			i++
		}
	}
	writeRun(len(rawSql))
	return b.String()
}

// timeMacros lists the supported macros. The function forms are checked before
// the scalar ones so that "$__timeFrom" never shadows a longer name.
var timeMacros = []string{"$__timeFilter", "$__timeGroup", "$__timeFrom", "$__timeTo"}

// expandMacroAt expands the macro that starts at position i. It reports ok =
// false when no macro starts there, or when a macro is present but cannot be
// expanded (a malformed $__timeGroup); the caller then copies the bytes
// unchanged so the database reports the problem instead of the plugin silently
// running a different statement.
func expandMacroAt(sql string, i int, from, to string) (string, int, bool) {
	for _, name := range timeMacros {
		if !strings.HasPrefix(sql[i:], name) {
			continue
		}
		open := i + len(name)
		for open < len(sql) && isSpaceByte(sql[open]) {
			open++
		}
		if open < len(sql) && sql[open] == '(' {
			closeIdx := matchingParen(sql, open)
			if closeIdx < 0 {
				return "", 0, false
			}
			arg := strings.TrimSpace(sql[open+1 : closeIdx])
			switch name {
			case "$__timeFilter":
				return fmt.Sprintf("(%s >= %s AND %s <= %s)", arg, from, arg, to), closeIdx + 1, true
			case "$__timeGroup":
				args := splitTopLevelArgs(arg)
				if len(args) != 2 {
					return "", 0, false
				}
				return fmt.Sprintf("time_bucket(%s, %s)", args[0], args[1]), closeIdx + 1, true
			}
			return "", 0, false
		}
		switch name {
		case "$__timeFrom":
			return from, i + len(name), true
		case "$__timeTo":
			return to, i + len(name), true
		}
		return "", 0, false
	}
	return "", 0, false
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

// matchingParen returns the index of the closing parenthesis that matches the
// opening parenthesis at open, or -1 when it is unbalanced.
func matchingParen(sql string, open int) int {
	depth := 0
	for i := open; i < len(sql); i++ {
		switch sql[i] {
		case '\'':
			i = skipSingleQuoted(sql, i, isEscapePrefixed(sql, i)) - 1
		case '"':
			i = skipDoubleQuoted(sql, i) - 1
		case '-':
			if i+1 < len(sql) && sql[i+1] == '-' {
				i = skipLineComment(sql, i) - 1
			}
		case '/':
			if i+1 < len(sql) && sql[i+1] == '*' {
				i = skipBlockComment(sql, i) - 1
			}
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// splitTopLevelArgs splits a macro argument list on commas that are not nested
// inside parentheses, strings or comments.
func splitTopLevelArgs(arg string) []string {
	var parts []string
	depth := 0
	start := 0
	for i := 0; i < len(arg); i++ {
		switch arg[i] {
		case '\'':
			i = skipSingleQuoted(arg, i, isEscapePrefixed(arg, i)) - 1
		case '"':
			i = skipDoubleQuoted(arg, i) - 1
		case '-':
			if i+1 < len(arg) && arg[i+1] == '-' {
				i = skipLineComment(arg, i) - 1
			}
		case '/':
			if i+1 < len(arg) && arg[i+1] == '*' {
				i = skipBlockComment(arg, i) - 1
			}
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(arg[start:i]))
				start = i + 1
			}
		}
	}
	parts = append(parts, strings.TrimSpace(arg[start:]))
	return parts
}
