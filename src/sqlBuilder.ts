import type { KwdbInterpolateMode, KwdbQuery, MetricSpec } from './types';

const INDENT = '       ';

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteQualified(name: string): string {
  return name
    .split('.')
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
    return String(normalizeInterpolateConstant(query.interpolateConstant));
  }
  return quoteString(mode);
}

function aggregationExpr(metric: MetricSpec): string {
  if (metric.aggregation === 'none') {
    return quoteIdent(metric.column);
  }
  return `${metric.aggregation}(${quoteIdent(metric.column)})`;
}

function metricAlias(metric: MetricSpec, prefix: string): string {
  if (metric.alias?.trim()) {
    return metric.alias.trim();
  }
  if (metric.aggregation === 'none') {
    return metric.column;
  }
  return `${prefix}_${metric.column}`;
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
  const expr = `${func}(${quoteIdent(metric.column)})`;
  return `${expr} AS ${quoteIdent(metric.alias?.trim() || `latest_${metric.column}`)}`;
}

function latestTimeExpr(query: KwdbQuery, timeColumn: string): string {
  const func = query.latestFunc === 'first' || query.latestFunc === 'first_row' ? 'first' : 'last';
  return `${func}(${quoteIdent(timeColumn)}) AS "time"`;
}

function timeExpr(functionName: 'time_bucket' | 'time_bucket_gapfill', query: KwdbQuery): string {
  return `${functionName}(${quoteIdent(query.timeColumn || '')}, ${quoteString(query.interval || '5m')})`;
}

function selectLines(items: string[]): string[] {
  return items.map((item, index) => {
    const comma = index < items.length - 1 ? ',' : '';
    return index === 0 ? `SELECT ${item}${comma}` : `${INDENT}${item}${comma}`;
  });
}

function groupAndOrderBy(tags: string[]): { groupBy: string[]; orderBy: string[] } {
  const quotedTags = tags.map(quoteIdent);
  return {
    groupBy: ['"time"', ...quotedTags],
    orderBy: ['"time"', ...quotedTags],
  };
}

function validMetrics(query: KwdbQuery): MetricSpec[] {
  return (query.metrics ?? []).filter((metric) => Boolean(metric.column?.trim()));
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
    `${timeExpr('time_bucket', query)} AS "time"`,
    ...tags.map(quoteIdent),
    ...metrics.map(metricExpr),
  ];
  const { groupBy, orderBy } = groupAndOrderBy(tags);
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
    `${timeExpr('time_bucket_gapfill', query)} AS "time"`,
    ...tags.map(quoteIdent),
    ...metrics.map((metric) => gapfillMetricExpr(metric, query)),
  ];
  const { groupBy, orderBy } = groupAndOrderBy(tags);
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

function windowTimeExpr(query: KwdbQuery): string | null {
  const timeColumn = query.timeColumn?.trim();
  switch (query.windowType) {
    case 'TIME_WINDOW':
    case 'SESSION_WINDOW': {
      if (!timeColumn) {
        return null;
      }
      const interval = quoteString(query.windowInterval || (query.windowType === 'SESSION_WINDOW' ? '5m' : '1h'));
      const slide = query.windowSlide?.trim();
      if (query.windowType === 'TIME_WINDOW' && slide) {
        return `TIME_WINDOW(${quoteIdent(timeColumn)}, ${interval}, ${quoteString(slide)})`;
      }
      return `${query.windowType}(${quoteIdent(timeColumn)}, ${interval})`;
    }
    case 'EVENT_WINDOW': {
      const start = query.eventStartCond?.trim();
      const end = query.eventEndCond?.trim();
      if (!start || !end) {
        return null;
      }
      return `EVENT_WINDOW(${start}, ${end})`;
    }
    case 'COUNT_WINDOW': {
      const limit = query.windowInterval?.trim();
      if (!limit) {
        return null;
      }
      const slide = query.windowSlide?.trim();
      return slide ? `COUNT_WINDOW(${limit}, ${slide})` : `COUNT_WINDOW(${limit})`;
    }
    case 'STATE_WINDOW': {
      const expr = query.eventStartCond?.trim();
      if (!expr) {
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
  const items = [
    `first(${quoteIdent(timeColumn)}) AS "time"`,
    ...tags.map(quoteIdent),
    ...metrics.map(metricExpr),
  ];
  const groupBy = [...tags.map(quoteIdent), windowExpr];
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
