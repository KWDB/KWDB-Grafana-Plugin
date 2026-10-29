package plugin

import (
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestExpandMacros(t *testing.T) {
	tr := backend.TimeRange{
		From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2026, 1, 1, 1, 0, 0, 0, time.UTC),
	}

	tests := []struct {
		name string
		sql  string
		want string
	}{
		{
			name: "time filter",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter(ts)",
			want: "SELECT * FROM sensors WHERE (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time from and to",
			sql:  "SELECT $__timeFrom AS start, $__timeTo AS end",
			want: "SELECT '2026-01-01 00:00:00'::TIMESTAMP AS start, '2026-01-01 01:00:00'::TIMESTAMP AS end",
		},
		{
			name: "time group",
			sql:  "SELECT $__timeGroup(ts, '5m') AS bucket",
			want: "SELECT time_bucket(ts, '5m') AS bucket",
		},
		{
			name: "quoted time group",
			sql:  `SELECT $__timeGroup("ts", '1h')`,
			want: `SELECT time_bucket("ts", '1h')`,
		},
		{
			name: "combined macros",
			sql:  "SELECT $__timeGroup(k_timestamp, '1m') AS time FROM sensors WHERE $__timeFilter(k_timestamp)",
			want: "SELECT time_bucket(k_timestamp, '1m') AS time FROM sensors WHERE (k_timestamp >= '2026-01-01 00:00:00'::TIMESTAMP AND k_timestamp <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time filter with nested cast",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter(CAST(ts AS TIMESTAMP))",
			want: "SELECT * FROM sensors WHERE (CAST(ts AS TIMESTAMP) >= '2026-01-01 00:00:00'::TIMESTAMP AND CAST(ts AS TIMESTAMP) <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time filter with nested function",
			sql:  "SELECT * FROM sensors WHERE $__timeFilter(time_bucket(ts, '5m'))",
			want: "SELECT * FROM sensors WHERE (time_bucket(ts, '5m') >= '2026-01-01 00:00:00'::TIMESTAMP AND time_bucket(ts, '5m') <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "negated time filter keeps its meaning",
			sql:  "SELECT * FROM sensors WHERE NOT $__timeFilter(ts)",
			want: "SELECT * FROM sensors WHERE NOT (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "time group with nested cast",
			sql:  "SELECT $__timeGroup(CAST(ts AS TIMESTAMP), '5m')",
			want: "SELECT time_bucket(CAST(ts AS TIMESTAMP), '5m')",
		},
		{
			name: "semicolon inside string literal is untouched",
			sql:  "SELECT * FROM t WHERE note = 'a;b' AND $__timeFilter(ts)",
			want: "SELECT * FROM t WHERE note = 'a;b' AND (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			// A macro that only appears inside a literal must be left alone:
			// expanding it corrupts the string and produces a syntax error.
			name: "time filter inside a string literal is not expanded",
			sql:  "SELECT 'range: $__timeFilter(ts)' AS note",
			want: "SELECT 'range: $__timeFilter(ts)' AS note",
		},
		{
			name: "time from inside a string literal is not expanded",
			sql:  "SELECT 'from $__timeFrom to $__timeTo' AS note",
			want: "SELECT 'from $__timeFrom to $__timeTo' AS note",
		},
		{
			name: "macro inside a quoted identifier is not expanded",
			sql:  `SELECT "$__timeFrom" FROM t`,
			want: `SELECT "$__timeFrom" FROM t`,
		},
		{
			name: "macro inside a line comment is not expanded",
			sql:  "SELECT 1 -- see $__timeFilter(ts)\nFROM t WHERE $__timeFilter(ts)",
			want: "SELECT 1 -- see $__timeFilter(ts)\nFROM t WHERE (ts >= '2026-01-01 00:00:00'::TIMESTAMP AND ts <= '2026-01-01 01:00:00'::TIMESTAMP)",
		},
		{
			name: "macro inside a block comment is not expanded",
			sql:  "SELECT 1 /* $__timeFrom */ FROM t WHERE k_timestamp >= $__timeFrom",
			want: "SELECT 1 /* $__timeFrom */ FROM t WHERE k_timestamp >= '2026-01-01 00:00:00'::TIMESTAMP",
		},
		{
			name: "macro inside a dollar-quoted string is not expanded",
			sql:  "SELECT $$literal $__timeFrom$$, $__timeFrom",
			want: "SELECT $$literal $__timeFrom$$, '2026-01-01 00:00:00'::TIMESTAMP",
		},
		{
			name: "escaped quote does not end the literal early",
			sql:  "SELECT 'it''s $__timeFrom' AS note, $__timeFrom",
			want: "SELECT 'it''s $__timeFrom' AS note, '2026-01-01 00:00:00'::TIMESTAMP",
		},
		{
			name: "macros on both sides of a literal",
			sql:  "SELECT $__timeFrom AS a, 'x' AS b, $__timeTo AS c",
			want: "SELECT '2026-01-01 00:00:00'::TIMESTAMP AS a, 'x' AS b, '2026-01-01 01:00:00'::TIMESTAMP AS c",
		},
		{
			name: "no macros",
			sql:  "SELECT 1",
			want: "SELECT 1",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ExpandMacros(tt.sql, tr); got != tt.want {
				t.Errorf("ExpandMacros() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExpandMacrosKeepsSubsecondPrecision(t *testing.T) {
	tr := backend.TimeRange{
		From: time.Date(2026, 1, 1, 0, 0, 0, 123456789, time.UTC),
		To:   time.Date(2026, 1, 1, 0, 0, 1, 987654321, time.UTC),
	}
	got := ExpandMacros("SELECT $__timeFrom AS start, $__timeTo AS end", tr)
	want := "SELECT '2026-01-01 00:00:00.123456789'::TIMESTAMP AS start, '2026-01-01 00:00:01.987654321'::TIMESTAMP AS end"
	if got != want {
		t.Errorf("ExpandMacros() = %q, want %q", got, want)
	}
}
