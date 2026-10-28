import type { KwdbVariableQuery } from './types';

const VARIABLE_QUERY_RE = /^(tag_values|tables|columns)\s*\((.*)\)$/i;

/**
 * Splits a comma-separated argument list, honouring single, double and back
 * quotes. A naive `split(',')` breaks `tag_values("my,sensors", device_id)`,
 * which is a legal (if unusual) table name.
 */
function splitArguments(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (const char of raw) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      args.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  args.push(current);

  return args;
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")) ||
      (s.startsWith('`') && s.endsWith('`')))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parses a template variable query into its structured form. `query` may be a
 * structured KwdbVariableQuery, a raw string such as `tag_values(table, column)`,
 * or null/undefined.
 *
 * The returned object is always a fresh copy, so callers cannot mutate the
 * parsed result by holding on to the object they passed in.
 */
export function parseVariableQuery(query: unknown): KwdbVariableQuery {
  if (query && typeof query === 'object' && typeof (query as KwdbVariableQuery).queryType === 'string') {
    const parsed = query as KwdbVariableQuery;
    switch (parsed.queryType) {
      case 'tables':
        return { queryType: 'tables' };
      case 'columns':
        if (!parsed.table?.trim()) {
          throw new Error('Variable query "columns" requires a table');
        }
        return { queryType: 'columns', table: parsed.table };
      case 'tagValues':
        if (!parsed.table?.trim() || !parsed.column?.trim()) {
          throw new Error('Variable query "tagValues" requires a table and a tag column');
        }
        return { queryType: 'tagValues', table: parsed.table, column: parsed.column };
      default:
        throw new Error(
          `Unsupported variable query type "${parsed.queryType}". Use tag_values(table, column), tables() or columns(table).`
        );
    }
  }

  // Trailing whitespace and semicolons are stripped together so that
  // `tables() ;  ;` and `tables();` are both accepted.
  const text = String(query ?? '')
    .trim()
    .replace(/[\s;]+$/, '');
  const match = VARIABLE_QUERY_RE.exec(text);
  if (!match) {
    throw new Error('Unsupported variable query. Use tag_values(table, column), tables() or columns(table).');
  }
  const fn = match[1].toLowerCase();
  const args = match[2].trim() ? splitArguments(match[2]).map((part) => stripQuotes(part.trim())) : [];

  switch (fn) {
    case 'tables':
      if (args.length !== 0) {
        throw new Error('Variable query tables() takes no arguments');
      }
      return { queryType: 'tables' };
    case 'columns':
      if (args.length !== 1 || !args[0]) {
        throw new Error('Variable query columns(table) requires exactly one table argument');
      }
      return { queryType: 'columns', table: args[0] };
    default:
      if (args.length !== 2 || !args[0] || !args[1]) {
        throw new Error('Variable query tag_values(table, column) requires exactly two arguments');
      }
      return { queryType: 'tagValues', table: args[0], column: args[1] };
  }
}

/**
 * Renders a single argument. A value that contains a comma must be quoted,
 * otherwise `parseVariableQuery` would read it as an argument separator and the
 * emitted definition could not be parsed back.
 */
function renderArgument(value: string): string {
  return value.includes(',') ? `"${value}"` : value;
}

/**
 * Renders the canonical raw query string shown as the variable definition in
 * Grafana. The output always round-trips through `parseVariableQuery`.
 */
export function buildVariableQueryString(query: KwdbVariableQuery): string {
  switch (query.queryType) {
    case 'tables':
      return 'tables()';
    case 'columns':
      if (!query.table?.trim()) {
        throw new Error('Variable query "columns" requires a table');
      }
      return `columns(${renderArgument(query.table)})`;
    case 'tagValues':
      if (!query.table?.trim() || !query.column?.trim()) {
        throw new Error('Variable query "tagValues" requires a table and a tag column');
      }
      return `tag_values(${renderArgument(query.table)}, ${renderArgument(query.column)})`;
    default:
      throw new Error(`Unsupported variable query type "${(query as KwdbVariableQuery).queryType}"`);
  }
}
