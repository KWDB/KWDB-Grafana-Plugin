package plugin

import (
	"fmt"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const macroTimeFormat = "2006-01-02 15:04:05.999999999"

// maxMacroNesting bounds recursive expansion inside macro arguments. Each
// expansion consumes the enclosing call, so real input terminates on its own;
// the cap only protects against pathological input (for example a statement
// built entirely from nested macro calls).
const maxMacroNesting = 8

const (
	timeFromMacro = "$__timeFrom"
	timeToMacro   = "$__timeTo"
)

// ExpandMacros replaces Grafana time macros with KWDB-compatible SQL
// fragments.
//
// Time macros are expanded by a paren-matching scanner instead of a regular
// expression so that nested expressions such as
// $__timeFilter(CAST(ts AS TIMESTAMP)) or $__timeFilter(time_bucket(ts, '5m'))
// expand correctly, and so that a macro used inside another macro's argument
// list (for example $__timeFilter($__timeGroup(ts, '5m'))) is expanded from the
// inside out. Every expansion is wrapped in parentheses so surrounding boolean
// operators keep their meaning.
//
// Expansion only happens in executable SQL: a macro that appears inside a
// string literal, a quoted identifier, a dollar-quoted string or a comment is
// left untouched, because rewriting it would corrupt that text. A macro call is
// consumed as a whole, including any literals and nested calls inside its
// argument list, so the scanner never splits $__timeGroup(ts, '5m') at the
// '5m'. The scalar macros are only replaced when their name stands alone: a
// '$__timeFrom' that continues an identifier (ts$__timeFrom) or that starts a
// dollar-quote tag ($__timeFrom$...$__timeFrom$) is not a macro.
func ExpandMacros(rawSql string, timeRange backend.TimeRange) string {
	from := fmt.Sprintf("'%s'::TIMESTAMP", timeRange.From.UTC().Format(macroTimeFormat))
	to := fmt.Sprintf("'%s'::TIMESTAMP", timeRange.To.UTC().Format(macroTimeFormat))
	return expandMacros(rawSql, from, to, 0)
}

// expandMacros is ExpandMacros with the rendered timestamp literals and the
// current nesting depth. depth is only used to bound the recursive expansion of
// macro arguments.
func expandMacros(rawSql, from, to string, depth int) string {
	if depth > maxMacroNesting || !strings.Contains(rawSql, "$__") {
		return rawSql
	}

	var b strings.Builder
	b.Grow(len(rawSql))
	// codeStart marks the beginning of the current run of executable SQL; only
	// those bytes reach the scalar replacement below.
	codeStart := 0
	// flushCode writes the executable SQL between start and end with the scalar
	// macros substituted. Literals and comments never pass through it, so a
	// macro inside them is not touched.
	flushCode := func(start, end int) {
		if end <= start {
			return
		}
		code := rawSql[start:end]
		code = replaceScalarMacro(code, timeFromMacro, from)
		code = replaceScalarMacro(code, timeToMacro, to)
		b.WriteString(code)
	}
	// copyVerbatim writes the executable SQL before the literal/comment and then
	// the literal itself unchanged.
	copyVerbatim := func(start, next int) {
		flushCode(codeStart, start)
		b.WriteString(rawSql[start:next])
		codeStart = next
	}
	for i := 0; i < len(rawSql); {
		if replacement, next, ok := expandMacroAt(rawSql, i, from, to, depth); ok {
			flushCode(codeStart, i)
			b.WriteString(replacement)
			i = next
			codeStart = next
			continue
		}
		switch c := rawSql[i]; {
		case c == '\'':
			next := skipSingleQuoted(rawSql, i, isEscapePrefixed(rawSql, i))
			copyVerbatim(i, next)
			i = next
		case c == '"':
			next := skipDoubleQuoted(rawSql, i)
			copyVerbatim(i, next)
			i = next
		case c == '$':
			if next, ok := skipDollarQuoted(rawSql, i); ok {
				copyVerbatim(i, next)
				i = next
				continue
			}
			i++
		case c == '-' && i+1 < len(rawSql) && rawSql[i+1] == '-':
			next := skipLineComment(rawSql, i)
			copyVerbatim(i, next)
			i = next
		case c == '/' && i+1 < len(rawSql) && rawSql[i+1] == '*':
			next := skipBlockComment(rawSql, i)
			copyVerbatim(i, next)
			i = next
		default:
			i++
		}
	}
	flushCode(codeStart, len(rawSql))
	return b.String()
}

// functionMacros lists the macros that take a parenthesised argument list. The
// scalar macros $__timeFrom and $__timeTo are handled by replaceScalarMacro,
// which requires the name to stand alone.
var functionMacros = []string{"$__timeFilter", "$__timeGroup"}

// expandMacroAt expands the function macro that starts at position i. It
// reports ok = false when no macro call starts there, or when a macro is
// present but cannot be expanded (an unbalanced call or a malformed
// $__timeGroup). In the second case the caller leaves the macro text in place
// so the database reports the problem instead of the plugin silently running a
// different statement; scalar macros elsewhere in the same text are still
// expanded.
//
// A macro in the argument list is expanded recursively (up to maxMacroNesting)
// before the outer macro is rendered.
func expandMacroAt(sql string, i int, from, to string, depth int) (string, int, bool) {
	for _, name := range functionMacros {
		if !strings.HasPrefix(sql[i:], name) {
			continue
		}
		open := i + len(name)
		for open < len(sql) && isSpaceByte(sql[open]) {
			open++
		}
		if open >= len(sql) || sql[open] != '(' {
			return "", 0, false
		}
		closeIdx := matchingParen(sql, open)
		if closeIdx < 0 {
			return "", 0, false
		}
		arg := strings.TrimSpace(sql[open+1 : closeIdx])
		switch name {
		case "$__timeFilter":
			arg = expandMacros(arg, from, to, depth+1)
			return fmt.Sprintf("(%s >= %s AND %s <= %s)", arg, from, arg, to), closeIdx + 1, true
		case "$__timeGroup":
			args := splitTopLevelArgs(arg)
			if len(args) != 2 {
				return "", 0, false
			}
			args[0] = expandMacros(args[0], from, to, depth+1)
			args[1] = expandMacros(args[1], from, to, depth+1)
			return fmt.Sprintf("time_bucket(%s, %s)", args[0], args[1]), closeIdx + 1, true
		}
		return "", 0, false
	}
	return "", 0, false
}

// replaceScalarMacro replaces name with replacement only where the name is a
// complete token: the bytes around it must not be able to continue a SQL
// identifier. PostgreSQL identifiers may contain '$' after the first byte, so
// '$' counts as an identifier byte. Without this check a legal identifier such
// as ts$__timeFrom, or the tag of a dollar-quoted literal such as
// $__timeFrom$...$__timeFrom$, would be rewritten and the statement corrupted.
func replaceScalarMacro(sql, name, replacement string) string {
	if !strings.Contains(sql, name) {
		return sql
	}
	var b strings.Builder
	b.Grow(len(sql))
	for i := 0; i < len(sql); {
		rel := strings.Index(sql[i:], name)
		if rel < 0 {
			b.WriteString(sql[i:])
			break
		}
		start := i + rel
		end := start + len(name)
		if isMacroBoundary(sql, start, end) {
			b.WriteString(sql[i:start])
			b.WriteString(replacement)
			i = end
			continue
		}
		// Not a standalone macro: keep the bytes up to and including the '$'
		// and keep looking right after it.
		b.WriteString(sql[i : start+1])
		i = start + 1
	}
	return b.String()
}

// isMacroBoundary reports whether the occurrence at [start,end) is delimited by
// bytes that cannot continue an identifier.
func isMacroBoundary(sql string, start, end int) bool {
	if start > 0 && isIdentContinue(sql[start-1]) {
		return false
	}
	if end < len(sql) && isIdentContinue(sql[end]) {
		return false
	}
	return true
}

func isIdentContinue(c byte) bool {
	return isWordByte(c) || c == '$'
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
		case '$':
			if next, ok := skipDollarQuoted(sql, i); ok {
				i = next - 1
			}
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
// inside parentheses, strings, dollar-quoted strings or comments.
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
		case '$':
			if next, ok := skipDollarQuoted(arg, i); ok {
				i = next - 1
			}
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
