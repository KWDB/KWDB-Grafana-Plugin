/**
 * Real-server verification harness (temporary, not part of the plugin build).
 *
 * Generates SQL using the *actual* source modules (src/sqlBuilder.ts and
 * src/variableQuery.ts) so the statements executed against a real KWDB are
 * byte-identical to what the plugin emits, then applies only the
 * $__timeFrom/$__timeTo expansion that the Go backend performs
 * (pkg/plugin/macros.go).
 *
 * $__timeFilter and $__timeGroup are expanded by the Go backend and covered by
 * the Go test suite; if a generated statement still contains one of them this
 * harness throws instead of writing a case that cannot be executed verbatim.
 *
 * Usage: npx ts-node --compiler-options '{"module":"commonjs"}' verify-real/gen.ts
 * Output: verify-real/cases.json (generated artifact, git-ignored)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSql } from '../src/sqlBuilder';
import { buildVariableQueryString, parseVariableQuery } from '../src/variableQuery';
import type { KwdbQuery } from '../src/types';

const FROM = '2026-10-27 00:00:00';
const TO = '2026-10-27 06:00:00';

/** Mirrors ExpandMacros in pkg/plugin/macros.go for the two scalar macros. */
function expand(sql: string): string {
  return sql.replaceAll('$__timeFrom', `'${FROM}'::TIMESTAMP`).replaceAll('$__timeTo', `'${TO}'::TIMESTAMP`);
}

const UNSUPPORTED_MACROS = ['$__timeFilter', '$__timeGroup'];

/**
 * This harness only mirrors the two scalar macros. A statement that still needs
 * the function-style macros must be expanded by the backend, so it cannot be
 * executed verbatim here.
 */
function assertExecutable(sql: string, id: string): string {
  for (const macro of UNSUPPORTED_MACROS) {
    if (sql.includes(macro)) {
      throw new Error(
        `${id}: generated SQL still contains ${macro}. verify-real only expands $__timeFrom/$__timeTo; ` +
          'add a raw case without function macros, or extend the harness deliberately.'
      );
    }
  }
  return sql;
}

const TABLE = 'equipment_telemetry';

const base: KwdbQuery = {
  refId: 'A',
  mode: 'downsampling',
  format: 'time_series',
  table: TABLE,
  timeColumn: 'k_timestamp',
  interval: '5m',
  metrics: [{ column: 'current_val', aggregation: 'avg' }],
};

interface Case {
  id: string;
  feature: string;
  expect: string;
  sql: string;
  /** KWDB rejects this statement on purpose; the UI no longer offers it. */
  expectFail?: boolean;
}

const cases: Case[] = [];

function add(id: string, feature: string, expect: string, query: KwdbQuery) {
  const sql = buildSql(query);
  cases.push({ id, feature, expect, sql: sql ? assertExecutable(expand(sql), id) : '' });
}

// ---------------------------------------------------------------- downsampling
add('DS-01', 'downsampling/basic', 'rows>0, cols: time, avg_current_val', base);
add('DS-02', 'downsampling/tags', 'rows = time buckets x 4 devices', {
  ...base,
  tags: ['device_id'],
});
add('DS-03', 'downsampling/multi-metric', 'avg+max+count in one SELECT', {
  ...base,
  metrics: [
    { column: 'current_val', aggregation: 'avg' },
    { column: 'voltage', aggregation: 'max' },
    { column: 'rpm', aggregation: 'count' },
  ],
});
add('DS-04', 'downsampling/blank-interval', 'interval falls back to 5m', {
  ...base,
  interval: '   ',
});
add('DS-05', 'downsampling/interval-trimmed', 'interval trimmed', {
  ...base,
  interval: '  1h  ',
});
add('DS-06', 'downsampling/agg-none-no-alias', 'bare column added to GROUP BY', {
  ...base,
  metrics: [{ column: 'current_val', aggregation: 'none' }],
});
add('DS-07', 'downsampling/agg-none-alias', 'column AS alias + GROUP BY', {
  ...base,
  metrics: [{ column: 'current_val', aggregation: 'none', alias: 'amps' }],
});
add('DS-08', 'downsampling/qualified-table', '"example_db"."equipment_telemetry"', {
  ...base,
  table: 'example_db.equipment_telemetry',
});
add('DS-09', 'downsampling/nullable-column', 'temperature is NULL-able', {
  ...base,
  metrics: [{ column: 'temperature', aggregation: 'avg' }],
});
add('DS-10', 'downsampling/stddev', 'stddev aggregation', {
  ...base,
  metrics: [{ column: 'current_val', aggregation: 'stddev' }],
});

// ---------------------------------------------------------------------- gapfill
for (const [mode, label] of [
  ['linear', 'linear'],
  ['prev', 'prev'],
  ['next', 'next'],
  ['null', 'null'],
] as const) {
  add(`GF-${mode}`, `gapfill/${label}`, `interpolate(..., '${mode}')`, {
    ...base,
    mode: 'gapfill',
    interpolateMode: mode,
  });
}
add('GF-constant', 'gapfill/constant', "interpolate(..., '0') quoted constant", {
  ...base,
  mode: 'gapfill',
  interpolateMode: 'constant',
});
add('GF-constant-value', 'gapfill/constant-value', "interpolate(..., '42')", {
  ...base,
  mode: 'gapfill',
  interpolateMode: 'constant',
  interpolateConstant: 42,
});
add('GF-constant-uppercase', 'gapfill/constant-uppercase', 'PREV normalised', {
  ...base,
  mode: 'gapfill',
  interpolateMode: 'PREV' as never,
});
add('GF-unknown-mode', 'gapfill/unknown-mode', 'falls back to linear', {
  ...base,
  mode: 'gapfill',
  interpolateMode: 'bogus' as never,
});
add('GF-tags', 'gapfill/tags', 'gapfill grouped by tag', {
  ...base,
  mode: 'gapfill',
  interpolateMode: 'linear',
  tags: ['device_id'],
});

// ----------------------------------------------------------------------- latest
for (const fn of ['last', 'last_row', 'first', 'first_row'] as const) {
  add(`LT-${fn}`, `latest/${fn}`, `${fn}(current_val) AS latest_current_val`, {
    ...base,
    mode: 'latest',
    latestFunc: fn,
    metrics: [{ column: 'current_val', aggregation: 'none' }],
  });
}
add('LT-tags', 'latest/tags', 'GROUP BY device_id', {
  ...base,
  mode: 'latest',
  latestFunc: 'last',
  tags: ['device_id'],
  metrics: [{ column: 'current_val', aggregation: 'none' }],
});
add('LT-alias', 'latest/alias', 'alias wins over latest_ prefix', {
  ...base,
  mode: 'latest',
  latestFunc: 'last_row',
  metrics: [{ column: 'current_val', aggregation: 'none', alias: 'amps' }],
});
add('LT-multi-metric', 'latest/multi-metric', 'two latest values', {
  ...base,
  mode: 'latest',
  latestFunc: 'last',
  metrics: [
    { column: 'current_val', aggregation: 'none' },
    { column: 'voltage', aggregation: 'none' },
  ],
});

// ----------------------------------------------------------------------- window
add('WN-time-window', 'window/TIME_WINDOW', 'TIME_WINDOW(ts, 1h)', {
  ...base,
  mode: 'window',
  windowType: 'TIME_WINDOW',
  windowInterval: '1h',
});
add('WN-time-window-slide', 'window/TIME_WINDOW+slide', 'TIME_WINDOW(ts, 1h, 10m)', {
  ...base,
  mode: 'window',
  windowType: 'TIME_WINDOW',
  windowInterval: '1h',
  windowSlide: '10m',
});
add('WN-time-window-default', 'window/TIME_WINDOW-default', 'interval defaults to 1h', {
  ...base,
  mode: 'window',
  windowType: 'TIME_WINDOW',
});
add('WN-session-window', 'window/SESSION_WINDOW', 'SESSION_WINDOW(ts, 5m)', {
  ...base,
  mode: 'window',
  windowType: 'SESSION_WINDOW',
  windowInterval: '5m',
});
add('WN-session-default', 'window/SESSION_WINDOW-default', 'interval defaults to 5m', {
  ...base,
  mode: 'window',
  windowType: 'SESSION_WINDOW',
});
add('WN-count-window', 'window/COUNT_WINDOW', 'COUNT_WINDOW(100) default limit', {
  ...base,
  mode: 'window',
  windowType: 'COUNT_WINDOW',
});
add('WN-count-window-slide', 'window/COUNT_WINDOW+slide', 'COUNT_WINDOW(100, 50)', {
  ...base,
  mode: 'window',
  windowType: 'COUNT_WINDOW',
  windowInterval: '100',
  windowSlide: '50',
});
add('WN-event-window', 'window/EVENT_WINDOW', 'EVENT_WINDOW(start, end)', {
  ...base,
  mode: 'window',
  windowType: 'EVENT_WINDOW',
  eventStartCond: 'current_val > 60',
  eventEndCond: 'current_val < 20',
});
add('WN-mixed-metrics', 'window/mixed-metrics', 'aggregated + bare column together', {
  ...base,
  mode: 'window',
  windowType: 'TIME_WINDOW',
  windowInterval: '1h',
  metrics: [
    { column: 'current_val', aggregation: 'avg' },
    { column: 'voltage', aggregation: 'none' },
  ],
});
add('WN-state-window', 'window/STATE_WINDOW', 'STATE_WINDOW(expr)', {
  ...base,
  mode: 'window',
  windowType: 'STATE_WINDOW',
  eventStartCond: 'case when status_code = 1 then 1 else 0 end',
});
add('WN-window-agg-none', 'window/agg-none', 'metric column before window in GROUP BY', {
  ...base,
  mode: 'window',
  windowType: 'TIME_WINDOW',
  windowInterval: '1h',
  metrics: [{ column: 'current_val', aggregation: 'none' }],
});
// interpolate() requires an aggregate as its first argument, so the SQL layer
// coerces a legacy gapfill `none` to `avg`. This case pins that coercion down;
// it is expected to execute now, not to reproduce the old KWDB error.
cases.push({
  id: 'WN-gapfill-agg-none',
  feature: 'gapfill/agg-none-coerced',
  expect: 'legacy none is coerced to avg and executes',
  sql: expand(
    buildSql({
      ...base,
      mode: 'gapfill',
      interpolateMode: 'linear',
      metrics: [{ column: 'current_val', aggregation: 'none' }],
    })
  ),
});
add('WN-event-window-reachable', 'window/EVENT_WINDOW-reachable', 'reachable end condition yields rows', {
  ...base,
  mode: 'window',
  windowType: 'EVENT_WINDOW',
  eventStartCond: 'current_val > 60',
  eventEndCond: 'current_val < 20',
});
add('WN-event-window-tags', 'window/EVENT_WINDOW+tags', 'GROUP BY tag, window', {
  ...base,
  mode: 'window',
  windowType: 'EVENT_WINDOW',
  eventStartCond: 'current_val > 20',
  eventEndCond: 'current_val < 5',
  tags: ['device_id'],
});
add('WN-unsafe-semicolon', 'window/unsafe-semicolon', 'returns empty SQL', {
  ...base,
  mode: 'window',
  windowType: 'EVENT_WINDOW',
  eventStartCond: 'current_val > 20; DROP TABLE x',
  eventEndCond: 'current_val < 5',
});
add('WN-unsafe-comment', 'window/unsafe-comment', 'returns empty SQL', {
  ...base,
  mode: 'window',
  windowType: 'STATE_WINDOW',
  eventStartCond: 'status_code = 1 -- comment',
});
add('WN-count-nonnumeric', 'window/COUNT_WINDOW-nonnumeric', 'returns empty SQL', {
  ...base,
  mode: 'window',
  windowType: 'COUNT_WINDOW',
  windowInterval: 'abc',
});
add('WN-count-slide-nonnumeric', 'window/COUNT_WINDOW-slide-nonnumeric', 'returns empty SQL', {
  ...base,
  mode: 'window',
  windowType: 'COUNT_WINDOW',
  windowSlide: 'abc',
});

// ------------------------------------------------------------------------- raw
// $__timeFilter / $__timeGroup are expanded by the Go backend
// (pkg/plugin/macros.go, covered by TestRealServerMacroExpansion), so the raw
// cases here are macro-free statements that must run verbatim.
const rawCases: Array<[string, string, string]> = [
  ['RAW-01', 'raw/plain-select', 'SELECT 1'],
  [
    'RAW-02',
    'raw/table-scan',
    'SELECT k_timestamp, device_id, current_val FROM equipment_telemetry ORDER BY k_timestamp LIMIT 50',
  ],
  ['RAW-03', 'raw/aggregate', 'SELECT count(*), avg(current_val) FROM equipment_telemetry'],
  ['RAW-04', 'raw/show-tables', 'SHOW TABLES FROM example_db'],
  ['RAW-05', 'raw/show-create', 'SHOW CREATE TABLE example_db.equipment_telemetry'],
  [
    'RAW-06',
    'raw/with-cte',
    'WITH x AS (SELECT device_id, count(*) AS n FROM equipment_telemetry GROUP BY device_id) SELECT * FROM x ORDER BY device_id',
  ],
  ['RAW-07', 'raw/explain', 'EXPLAIN SELECT 1'],
  [
    'RAW-08',
    'raw/timeFromTo',
    'SELECT count(*) FROM equipment_telemetry WHERE k_timestamp >= $__timeFrom AND k_timestamp <= $__timeTo',
  ],
];
for (const [id, feature, rawSql] of rawCases) {
  const sql = assertExecutable(expand(rawSql), id);
  cases.push({ id, feature, expect: 'executes', sql });
}

// --------------------------------------------------------- variable query round-trip
const varRoundTrip: Array<[string, string]> = [
  ['VQ-01', 'tables()'],
  ['VQ-02', 'tables() ;'],
  ['VQ-03', 'columns(equipment_telemetry)'],
  ['VQ-04', 'columns("equipment_telemetry")'],
  ['VQ-05', 'tag_values(equipment_telemetry, device_id)'],
  ['VQ-06', "tag_values('equipment_telemetry', 'device_id')"],
  ['VQ-07', 'TABLES()'],
  ['VQ-08', '  tag_values( equipment_telemetry , device_id )  '],
];
const varResults: unknown[] = [];
for (const [id, raw] of varRoundTrip) {
  try {
    const parsed = parseVariableQuery(raw);
    const rendered = buildVariableQueryString(parsed);
    varResults.push({ id, raw, parsed, rendered, roundTrip: parseVariableQuery(rendered) });
  } catch (err) {
    varResults.push({ id, raw, error: String(err) });
  }
}

const varRejects = [
  'tag_values(equipment_telemetry)',
  'columns()',
  'columns(a, b)',
  'tables(x)',
  'select 1',
  'tag_values(equipment_telemetry, device_id, extra)',
];
const varRejectResults = varRejects.map((raw) => {
  try {
    return { raw, parsed: parseVariableQuery(raw), rejected: false };
  } catch (err) {
    return { raw, rejected: true, error: String(err) };
  }
});

// The actual SQL the backend runs for each variable query type.
const varSql: Array<{ id: string; sql: string }> = [
  { id: 'VQ-tables', sql: 'SHOW TABLES FROM "example_db"' },
  { id: 'VQ-columns', sql: 'SHOW CREATE TABLE "example_db"."equipment_telemetry"' },
  {
    id: 'VQ-tag-values',
    sql: 'SELECT DISTINCT "device_id" FROM "example_db"."equipment_telemetry" ORDER BY "device_id" LIMIT 10000',
  },
  {
    id: 'VQ-tag-values-multi',
    sql: 'SELECT DISTINCT "workshop_id" FROM "example_db"."equipment_telemetry" ORDER BY "workshop_id" LIMIT 10000',
  },
];

writeFileSync(join(__dirname, 'cases.json'), JSON.stringify({ cases, varResults, varRejectResults, varSql }, null, 2));

const empty = cases.filter((c) => !c.sql);
console.log(`generated ${cases.length} cases, ${empty.length} intentionally empty`);
console.log(`variable round-trip: ${varResults.length}, rejects: ${varRejectResults.length}, sql: ${varSql.length}`);
