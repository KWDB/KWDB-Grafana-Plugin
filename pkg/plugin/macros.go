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
func ExpandMacros(rawSql string, timeRange backend.TimeRange) string {
	from := fmt.Sprintf("'%s'::TIMESTAMP", timeRange.From.UTC().Format(macroTimeFormat))
	to := fmt.Sprintf("'%s'::TIMESTAMP", timeRange.To.UTC().Format(macroTimeFormat))

	sql := expandMacroCalls(rawSql, "$__timeFilter", func(arg string) string {
		return fmt.Sprintf("(%s >= %s AND %s <= %s)", arg, from, arg, to)
	})
	sql = expandMacroCalls(sql, "$__timeGroup", func(arg string) string {
		args := splitTopLevelArgs(arg)
		if len(args) != 2 {
			// Leave the macro untouched so the database reports a syntax error
			// instead of silently running an unexpected query.
			return "$__timeGroup(" + arg + ")"
		}
		return fmt.Sprintf("time_bucket(%s, %s)", args[0], args[1])
	})
	sql = strings.ReplaceAll(sql, "$__timeFrom", from)
	sql = strings.ReplaceAll(sql, "$__timeTo", to)
	return sql
}

// expandMacroCalls replaces name(arg) occurrences using expand for the
// argument text. Nested parentheses, single-quoted strings, double-quoted
// identifiers and comments inside the argument are handled.
func expandMacroCalls(sql, name string, expand func(arg string) string) string {
	if !strings.Contains(sql, name) {
		return sql
	}
	var b strings.Builder
	b.Grow(len(sql))
	for i := 0; i < len(sql); {
		if !strings.HasPrefix(sql[i:], name) {
			b.WriteByte(sql[i])
			i++
			continue
		}
		open := i + len(name)
		for open < len(sql) && (sql[open] == ' ' || sql[open] == '\t' || sql[open] == '\n' || sql[open] == '\r') {
			open++
		}
		if open >= len(sql) || sql[open] != '(' {
			b.WriteString(name)
			i += len(name)
			continue
		}
		close := matchingParen(sql, open)
		if close < 0 {
			b.WriteString(sql[i:])
			break
		}
		arg := strings.TrimSpace(sql[open+1 : close])
		b.WriteString(expand(arg))
		i = close + 1
	}
	return b.String()
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
