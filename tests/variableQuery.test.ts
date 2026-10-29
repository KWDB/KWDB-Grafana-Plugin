import type { KwdbVariableQuery } from '../src/types';
import { buildVariableQueryString, parseVariableQuery } from '../src/variableQuery';

function parse(value: unknown): KwdbVariableQuery {
  return parseVariableQuery(value);
}

function roundTrip(value: KwdbVariableQuery): KwdbVariableQuery {
  return parseVariableQuery(buildVariableQueryString(value));
}

describe('parseVariableQuery with structured input', () => {
  it('accepts a tables query', () => {
    expect(parse({ queryType: 'tables' })).toEqual({ queryType: 'tables' });
  });

  it('accepts a columns query with a table', () => {
    expect(parse({ queryType: 'columns', table: 'sensors' })).toEqual({
      queryType: 'columns',
      table: 'sensors',
    });
  });

  it('accepts a tagValues query with a table and a column', () => {
    expect(parse({ queryType: 'tagValues', table: 'sensors', column: 'device_id' })).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });
  });

  it('rejects a columns query without a table', () => {
    expect(() => parse({ queryType: 'columns' })).toThrow('Variable query "columns" requires a table');
    expect(() => parse({ queryType: 'columns', table: '   ' })).toThrow('Variable query "columns" requires a table');
  });

  it('rejects a tagValues query without a table or column', () => {
    expect(() => parse({ queryType: 'tagValues', table: 'sensors' })).toThrow(
      'Variable query "tagValues" requires a table and a tag column'
    );
    expect(() => parse({ queryType: 'tagValues', column: 'device_id' })).toThrow(
      'Variable query "tagValues" requires a table and a tag column'
    );
    expect(() => parse({ queryType: 'tagValues', table: 'sensors', column: '  ' })).toThrow(
      'Variable query "tagValues" requires a table and a tag column'
    );
  });

  it('rejects unknown query types instead of passing them through', () => {
    // Previously a bogus queryType reached metricFindQuery, which reported it as a
    // JSON dump. It is rejected here now, with a readable message.
    expect(() => parse({ queryType: 'bogus' } as unknown as KwdbVariableQuery)).toThrow(
      'Unsupported variable query type "bogus"'
    );
  });

  it('returns a copy so the caller cannot mutate the parsed result', () => {
    const input: KwdbVariableQuery = { queryType: 'tagValues', table: 'sensors', column: 'device_id' };
    const parsed = parse(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);

    parsed.table = 'changed';
    expect(input.table).toBe('sensors');
  });

  it('rejects non-string structured table or column fields with a readable error', () => {
    expect(() => parse({ queryType: 'columns', table: 5 })).toThrow('Variable query "columns" requires a table');
    expect(() => parse({ queryType: 'tagValues', table: 'sensors', column: 5 })).toThrow(
      'Variable query "tagValues" requires a table and a tag column'
    );
  });

  it('rejects parentheses in a structured table or column name', () => {
    expect(() => parse({ queryType: 'columns', table: 'a)(b' })).toThrow('cannot contain "(" or ")"');
    expect(() => parse({ queryType: 'tagValues', table: 'sensors', column: 'a(b' })).toThrow(
      'cannot contain "(" or ")"'
    );
  });

  it('treats a non-string queryType as a raw string and rejects it', () => {
    expect(() => parse({ queryType: 5 })).toThrow('Unsupported variable query');
  });
});

describe('parseVariableQuery with string input', () => {
  it('parses tables()', () => {
    expect(parse('tables()')).toEqual({ queryType: 'tables' });
  });

  it('trims surrounding whitespace', () => {
    expect(parse('  tables( )  ')).toEqual({ queryType: 'tables' });
    expect(parse('\n\tcolumns(sensors)\n')).toEqual({ queryType: 'columns', table: 'sensors' });
  });

  it('strips semicolons that directly follow the closing parenthesis', () => {
    expect(parse('tables();')).toEqual({ queryType: 'tables' });
    expect(parse('tables();;')).toEqual({ queryType: 'tables' });
    expect(parse('columns(sensors);')).toEqual({ queryType: 'columns', table: 'sensors' });
  });

  it('strips trailing semicolons even when whitespace separates them', () => {
    expect(parse('tables() ;')).toEqual({ queryType: 'tables' });
    expect(parse('tables() ;  ;')).toEqual({ queryType: 'tables' });
    expect(parse('columns(sensors) ;')).toEqual({ queryType: 'columns', table: 'sensors' });
  });

  it('is case-insensitive for the function name', () => {
    expect(parse('TABLES()')).toEqual({ queryType: 'tables' });
    expect(parse('Columns(sensors)')).toEqual({ queryType: 'columns', table: 'sensors' });
    expect(parse('Tag_Values(sensors, device_id)')).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });
  });

  it('parses columns(table)', () => {
    expect(parse('columns(sensors)')).toEqual({ queryType: 'columns', table: 'sensors' });
    expect(parse('columns( sensors )')).toEqual({ queryType: 'columns', table: 'sensors' });
  });

  it('strips single, double and backtick quotes from the table argument', () => {
    expect(parse("columns('sensors')")).toEqual({ queryType: 'columns', table: 'sensors' });
    expect(parse('columns("sensors")')).toEqual({ queryType: 'columns', table: 'sensors' });
    expect(parse('columns(`sensors`)')).toEqual({ queryType: 'columns', table: 'sensors' });
  });

  it('keeps arguments that contain spaces', () => {
    expect(parse('columns(my sensors)')).toEqual({ queryType: 'columns', table: 'my sensors' });
  });

  it('parses tag_values(table, column)', () => {
    expect(parse('tag_values(sensors, device_id)')).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });
    expect(parse('tag_values(sensors,device_id)')).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });
  });

  it('strips quotes from both tag_values arguments', () => {
    expect(parse('tag_values(\'sensors\', "device_id")')).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });
    expect(parse('tag_values(`sensors`, `device_id`)')).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });
  });

  it('rejects tables() with arguments', () => {
    expect(() => parse('tables(sensors)')).toThrow('Variable query tables() takes no arguments');
  });

  it('rejects columns() without exactly one non-empty argument', () => {
    expect(() => parse('columns()')).toThrow('Variable query columns(table) requires exactly one table argument');
    expect(() => parse('columns(sensors, device_id)')).toThrow(
      'Variable query columns(table) requires exactly one table argument'
    );
    expect(() => parse("columns('')")).toThrow('Variable query columns(table) requires exactly one table argument');
  });

  it('rejects tag_values() without exactly two non-empty arguments', () => {
    expect(() => parse('tag_values(sensors)')).toThrow(
      'Variable query tag_values(table, column) requires exactly two arguments'
    );
    expect(() => parse('tag_values(sensors, device_id, extra)')).toThrow(
      'Variable query tag_values(table, column) requires exactly two arguments'
    );
    expect(() => parse('tag_values(, device_id)')).toThrow(
      'Variable query tag_values(table, column) requires exactly two arguments'
    );
    expect(() => parse('tag_values(sensors, )')).toThrow(
      'Variable query tag_values(table, column) requires exactly two arguments'
    );
  });

  it('rejects an unknown function', () => {
    expect(() => parse('show_tables()')).toThrow('Unsupported variable query');
    expect(() => parse('tag_value(sensors, device_id)')).toThrow('Unsupported variable query');
  });

  it('rejects null, undefined and empty input', () => {
    expect(() => parse(null)).toThrow('Unsupported variable query');
    expect(() => parse(undefined)).toThrow('Unsupported variable query');
    expect(() => parse('')).toThrow('Unsupported variable query');
    expect(() => parse('   ')).toThrow('Unsupported variable query');
  });

  it('only strips semicolons at the end of the query', () => {
    expect(() => parse('columns(sensors); SELECT 1')).toThrow('Unsupported variable query');
    expect(() => parse(';tables()')).toThrow('Unsupported variable query');
  });

  it('rejects multi-line queries', () => {
    expect(() => parse('tables(\n)')).toThrow('Unsupported variable query');
  });

  it('keeps a comma inside a quoted argument', () => {
    expect(parse('tag_values("my,sensors", device_id)')).toEqual({
      queryType: 'tagValues',
      table: 'my,sensors',
      column: 'device_id',
    });
    expect(parse('columns("my,sensors")')).toEqual({ queryType: 'columns', table: 'my,sensors' });
  });

  it('rejects an unmatched quote instead of silently splitting the value', () => {
    expect(() => parse("tag_values('sensors, device_id)")).toThrow(
      'Variable query tag_values(table, column) requires exactly two arguments'
    );
  });

  it('rejects parentheses inside an argument', () => {
    // `columns(a)(b)` used to be accepted with table `a)(b`, because the
    // trailing `)` matched the pattern and the inner parentheses were kept.
    expect(() => parse('columns(a)(b)')).toThrow('cannot contain "(" or ")"');
    expect(() => parse('columns(a))')).toThrow('cannot contain "(" or ")"');
    expect(() => parse('tag_values(a)(b, c)')).toThrow('cannot contain "(" or ")"');
    expect(() => parse('tag_values(sensors, a(b))')).toThrow('cannot contain "(" or ")"');
  });

  it('unescapes a doubled double quote inside an argument', () => {
    expect(parse('tag_values("a""b", column_1)')).toEqual({
      queryType: 'tagValues',
      table: 'a"b',
      column: 'column_1',
    });
  });
});

describe('buildVariableQueryString', () => {
  it('renders tables()', () => {
    expect(buildVariableQueryString({ queryType: 'tables' })).toBe('tables()');
  });

  it('renders columns(table)', () => {
    expect(buildVariableQueryString({ queryType: 'columns', table: 'sensors' })).toBe('columns(sensors)');
  });

  it('renders tag_values(table, column)', () => {
    expect(buildVariableQueryString({ queryType: 'tagValues', table: 'sensors', column: 'device_id' })).toBe(
      'tag_values(sensors, device_id)'
    );
  });

  it('refuses to render a string it could not parse back', () => {
    // Previously these produced `columns()` and `tag_values(sensors, )`, neither of
    // which parseVariableQuery accepts - the variable definition in Grafana would
    // show a query the plugin itself rejects.
    expect(() => buildVariableQueryString({ queryType: 'columns' })).toThrow(
      'Variable query "columns" requires a table'
    );
    expect(() => buildVariableQueryString({ queryType: 'tagValues', table: 'sensors' })).toThrow(
      'Variable query "tagValues" requires a table and a tag column'
    );
  });

  it('quotes an argument that contains a quote character', () => {
    expect(buildVariableQueryString({ queryType: 'columns', table: "o'brien" })).toBe('columns("o\'brien")');
    expect(buildVariableQueryString({ queryType: 'tagValues', table: 'a",b', column: 'c' })).toBe(
      'tag_values("a"",b", c)'
    );
    expect(buildVariableQueryString({ queryType: 'columns', table: 'a`b' })).toBe('columns("a`b")');
  });

  it('refuses to render an argument it could not parse back', () => {
    expect(() => buildVariableQueryString({ queryType: 'columns', table: 'a)(b' })).toThrow(
      'cannot contain "(" or ")"'
    );
    expect(() => buildVariableQueryString({ queryType: 'tagValues', table: 'a\nb', column: 'device_id' })).toThrow(
      'cannot contain a line break'
    );
  });

  it('throws for an unknown query type', () => {
    expect(() => buildVariableQueryString({ queryType: 'bogus' } as unknown as KwdbVariableQuery)).toThrow(
      'Unsupported variable query type "bogus"'
    );
  });
});

describe('parse -> build -> parse round trip', () => {
  it('round trips tables()', () => {
    expect(roundTrip({ queryType: 'tables' })).toEqual({ queryType: 'tables' });
  });

  it('round trips columns(table)', () => {
    expect(roundTrip({ queryType: 'columns', table: 'sensors' })).toEqual({
      queryType: 'columns',
      table: 'sensors',
    });
  });

  it('round trips tag_values(table, column)', () => {
    expect(roundTrip({ queryType: 'tagValues', table: 'sensors', column: 'device_id' })).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });
  });

  it('trims surrounding whitespace on the way back', () => {
    expect(roundTrip({ queryType: 'columns', table: '  sensors  ' })).toEqual({
      queryType: 'columns',
      table: 'sensors',
    });
  });

  it('round trips a table name that contains a comma', () => {
    expect(roundTrip({ queryType: 'tagValues', table: 'my,sensors', column: 'device_id' })).toEqual({
      queryType: 'tagValues',
      table: 'my,sensors',
      column: 'device_id',
    });
  });

  it('round trips names containing quotes, commas and backticks', () => {
    const values: KwdbVariableQuery[] = [
      { queryType: 'columns', table: "o'brien" },
      { queryType: 'columns', table: 'a"b' },
      { queryType: 'columns', table: 'a,b' },
      { queryType: 'columns', table: 'a`b' },
      { queryType: 'tagValues', table: 'a",b', column: "o'brien" },
      { queryType: 'tagValues', table: 'my,sensors', column: 'device_id' },
    ];
    for (const value of values) {
      expect(parse(buildVariableQueryString(value))).toEqual(value);
    }
  });

  it('survives the string form of every query type', () => {
    for (const raw of ['tables()', 'columns(sensors)', 'tag_values(sensors, device_id)']) {
      const structured = parse(raw);
      expect(buildVariableQueryString(structured)).toBe(raw);
      expect(parse(buildVariableQueryString(structured))).toEqual(structured);
    }
  });
});
