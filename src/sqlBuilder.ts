import type { KwdbInterpolateMode, KwdbQuery, MetricSpec } from './types';

const INDENT = '       ';

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Quotes a possibly schema-qualified identifier such as `db.table`.
 *
 * Dots are only treated as separators when they are outside double quotes, so
 * an identifier that legitimately contains a dot (`"my.table"`) stays a single
 * quoted identifier instead of being rewritten into `"my"."table"`.
 */
function quoteQualified(name: string): string {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of name) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === '.' && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map(quoteIdent)
    .join('.');
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const INTERPOLATE_MODES: readonly KwdbInterpolateMode[] = ['linear', 'prev', 'next', 'null', 'constant'];

/**
 * Normalizes the interpolation mode, including uppercase values such as
 * `PREV` / `NEXT` / `NULL` that older dashboards may still contain.
 */
export function normalizeInterpolateMode(mode?: string): KwdbInterpolateMode {
  const normalized = mode?.trim().toLowerCase();
  return INTERPOLATE_MODES.find((item) => item === normalized) ?? 'linear';
}

function normalizeInterpolateConstant(value?: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function interpolateModeLiteral(query: KwdbQuery): string {
  const mode = normalizeInterpolateMode(query.interpolateMode);
  if (mode === 'constant') {
    // KWDB's interpolate() takes a constant value, not a 'constant' keyword:
    // interpolate(expr, 'constant') fails with "Interpolate/imputation method
    // not supported". The value is emitted as a quoted numeric string, matching
    // the form in the KWDB documentation (interpolate(avg(temperature), '25')).
    return quoteString(String(normalizeInterpolateConstant(query.interpolateConstant)));
  }
  return quoteString(mode);
}

function aggregationExpr(metric: MetricSpec): string {
  const column = metric.column?.trim() ?? '';
  if (metric.aggregation === 'none') {
    return quoteIdent(column);
  }
  return `${metric.aggregation}(${quoteIdent(column)})`;
}

/**
 * Builds the implicit alias for a metric. Only reached without an explicit
 * alias and with an aggregation, because both call sites return early when the
 * aggregation is `none` and no alias was given.
 */
function metricAlias(metric: MetricSpec, prefix: string): string {
  return `${prefix}_${metric.column?.trim() ?? ''}`;
}

function metricExpr(metric: MetricSpec): string {
  const expr = aggregationExpr(metric);
  const alias = metric.alias?.trim();
  if (metric.aggregation === 'none' && !alias) {
    return expr;
  }
  return `${expr} AS ${quoteIdent(alias || metricAlias(metric, metric.aggregation))}`;
}

function gapfillMetricExpr(metric: MetricSpec, query: KwdbQuery): string {
  const inner = aggregationExpr(metric);
  const expr = `interpolate(${inner}, ${interpolateModeLiteral(query)})`;
  const alias = metric.alias?.trim();
  if (metric.aggregation === 'none' && !alias) {
    return expr;
  }
  return `${expr} AS ${quoteIdent(alias || metricAlias(metric, metric.aggregation))}`;
}

function latestMetricExpr(metric: MetricSpec, latestFunc: KwdbQuery['latestFunc']): string {
  const func = latestFunc ?? 'last';
  const expr = `${func}(${quoteIdent(metric.column?.trim() ?? '')})`;
  return `${expr} AS ${quoteIdent(metric.alias?.trim() || `latest_${metric.column?.trim() ?? ''}`)}`;
}

function latestTimeExpr(query: KwdbQuery, timeColumn: string): string {
  const func = query.latestFunc === 'first' || query.latestFunc === 'first_row' ? 'first' : 'last';
  return `${func}(${quoteIdent(timeColumn)}) AS "time"`;
}

function timeExpr(functionName: 'time_bucket' | 'time_bucket_gapfill', query: KwdbQuery, timeColumn: string): string {
  // A blank interval is treated as "not set" rather than being passed through:
  // `time_bucket(ts, '   ')` is a hard SQL error, not a usable default.
  const interval = query.interval?.trim() || '5m';
  return `${functionName}(${quoteIdent(timeColumn)}, ${quoteString(interval)})`;
}

function selectLines(items: string[]): string[] {
  return items.map((item, index) => {
    const comma = index < items.length - 1 ? ',' : '';
    return index === 0 ? `SELECT ${item}${comma}` : `${INDENT}${item}${comma}`;
  });
}

function groupAndOrderBy(tags: string[], rawColumns: string[] = []): { groupBy: string[]; orderBy: string[] } {
  const quotedTags = tags.map(quoteIdent);
  return {
    groupBy: ['"time"', ...quotedTags, ...rawColumns],
    orderBy: ['"time"', ...quotedTags, ...rawColumns],
  };
}

function validMetrics(query: KwdbQuery): MetricSpec[] {
  return (query.metrics ?? []).filter((metric) => Boolean(metric.column?.trim()));
}

/**
 * Metric columns selected without an aggregation.
 *
 * KWDB rejects a bare column in a grouped SELECT ("column ... must appear in
 * the GROUP BY clause or be used in an aggregate function"), so these columns
 * have to be added to the GROUP BY list instead of being dropped. Verified
 * against KWDB 3.3.0: `GROUP BY "time", "current_val"` is accepted by
 * time_bucket, time_bucket_gapfill and every window function.
 */
function unaggregatedColumns(metrics: MetricSpec[]): string[] {
  const columns: string[] = [];
  for (const metric of metrics) {
    const column = metric.column?.trim() ?? '';
    if (metric.aggregation === 'none' && column) {
      const quoted = quoteIdent(column);
      if (!columns.includes(quoted)) {
        columns.push(quoted);
      }
    }
  }
  return columns;
}

export function buildDownsamplingSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query);
  if (!table || !timeColumn || metrics.length === 0) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [
    `${timeExpr('time_bucket', query, timeColumn)} AS "time"`,
    ...tags.map(quoteIdent),
    ...metrics.map(metricExpr),
  ];
  const raw = unaggregatedColumns(metrics);
  const { groupBy, orderBy } = groupAndOrderBy(tags, raw);
  return [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
    `GROUP BY ${groupBy.join(', ')}`,
    `ORDER BY ${orderBy.join(', ')}`,
  ].join('\n');
}

export function buildGapfillSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query);
  if (!table || !timeColumn || metrics.length === 0) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [
    `${timeExpr('time_bucket_gapfill', query, timeColumn)} AS "time"`,
    ...tags.map(quoteIdent),
    ...metrics.map((metric) => gapfillMetricExpr(metric, query)),
  ];
  const raw = unaggregatedColumns(metrics);
  const { groupBy, orderBy } = groupAndOrderBy(tags, raw);
  return [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
    `GROUP BY ${groupBy.join(', ')}`,
    `ORDER BY ${orderBy.join(', ')}`,
  ].join('\n');
}

export function buildLatestSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query);
  if (!table || !timeColumn || metrics.length === 0) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [
    ...tags.map(quoteIdent),
    ...metrics.map((metric) => latestMetricExpr(metric, query.latestFunc)),
    latestTimeExpr(query, timeColumn),
  ];
  const lines = [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
  ];
  if (tags.length > 0) {
    lines.push(`GROUP BY ${tags.map(quoteIdent).join(', ')}`);
  }
  return lines.join('\n');
}

// Free-form SQL fragments (event and state conditions, window limits) are
// spliced into the statement verbatim, so anything that could terminate the
// statement or open a comment is rejected here. The backend read-only guard is
// the last line of defence; this keeps the editor from producing a statement
// that only fails deep inside the database.
const UNSAFE_SQL_FRAGMENT_RE = /;|--|\/\*|\*\//;

function isSafeSqlFragment(fragment: string): boolean {
  return !UNSAFE_SQL_FRAGMENT_RE.test(fragment);
}

// COUNT_WINDOW arguments are unquoted numbers.
const NUMERIC_RE = /^\d+(\.\d+)?$/;

function windowTimeExpr(query: KwdbQuery): string | null {
  const timeColumn = query.timeColumn?.trim();
  switch (query.windowType) {
    case 'TIME_WINDOW':
    case 'SESSION_WINDOW': {
      if (!timeColumn) {
        return null;
      }
      const interval = quoteString(
        query.windowInterval?.trim() || (query.windowType === 'SESSION_WINDOW' ? '5m' : '1h')
      );
      const slide = query.windowSlide?.trim();
      if (query.windowType === 'TIME_WINDOW' && slide) {
        return `TIME_WINDOW(${quoteIdent(timeColumn)}, ${interval}, ${quoteString(slide)})`;
      }
      return `${query.windowType}(${quoteIdent(timeColumn)}, ${interval})`;
    }
    case 'EVENT_WINDOW': {
      const start = query.eventStartCond?.trim();
      const end = query.eventEndCond?.trim();
      if (!start || !end || !isSafeSqlFragment(start) || !isSafeSqlFragment(end)) {
        return null;
      }
      return `EVENT_WINDOW(${start}, ${end})`;
    }
    case 'COUNT_WINDOW': {
      // Defaults to 100 because that is the initial value the editor shows in
      // the "Row limit" field. Without the default the two disagree: the field
      // reads 100 while the generated statement is empty, and setting the field
      // to the value it already displays is a no-op for a React controlled
      // input, so the user cannot make the preview appear by typing it in.
      const limit = query.windowInterval?.trim() || '100';
      if (!NUMERIC_RE.test(limit)) {
        return null;
      }
      const slide = query.windowSlide?.trim();
      if (slide && !NUMERIC_RE.test(slide)) {
        return null;
      }
      return slide ? `COUNT_WINDOW(${limit}, ${slide})` : `COUNT_WINDOW(${limit})`;
    }
    case 'STATE_WINDOW': {
      const expr = query.eventStartCond?.trim();
      if (!expr || !isSafeSqlFragment(expr)) {
        return null;
      }
      return `STATE_WINDOW(${expr})`;
    }
    default:
      return null;
  }
}

export function buildWindowSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query);
  const windowExpr = windowTimeExpr(query);
  if (!table || !timeColumn || metrics.length === 0 || !windowExpr) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [`first(${quoteIdent(timeColumn)}) AS "time"`, ...tags.map(quoteIdent), ...metrics.map(metricExpr)];
  // KWDB requires a grouped window function to be the *last* GROUP BY entry:
  // "no other columns can follow grouped window function". Non-aggregated
  // metric columns therefore go before the window expression.
  const groupBy = [...tags.map(quoteIdent), ...unaggregatedColumns(metrics), windowExpr];
  const orderBy = ['"time"', ...tags.map(quoteIdent)];
  return [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
    `GROUP BY ${groupBy.join(', ')}`,
    `ORDER BY ${orderBy.join(', ')}`,
  ].join('\n');
}

export function buildRawSql(query: KwdbQuery): string {
  return query.rawSql ?? '';
}

export function buildSql(query: KwdbQuery): string {
  switch (query.mode) {
    case 'gapfill':
      return buildGapfillSql(query);
    case 'latest':
      return buildLatestSql(query);
    case 'window':
      return buildWindowSql(query);
    case 'raw':
      return buildRawSql(query);
    case 'downsampling':
    default:
      return buildDownsamplingSql(query);
  }
}
