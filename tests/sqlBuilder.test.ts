import type { KwdbInterpolateMode, KwdbQuery, MetricSpec } from '../src/types';
import {
  buildDownsamplingSql,
  buildGapfillSql,
  buildLatestSql,
  buildRawSql,
  buildSql,
  buildWindowSql,
  normalizeInterpolateMode,
} from '../src/sqlBuilder';

const TIME_MACROS = 'WHERE "ts" >= $__timeFrom AND "ts" <= $__timeTo';

function metric(overrides: Partial<MetricSpec> = {}): MetricSpec {
  return { column: 'temperature', aggregation: 'avg', ...overrides };
}

function query(overrides: Partial<KwdbQuery> = {}): KwdbQuery {
  return {
    refId: 'A',
    mode: 'downsampling',
    format: 'time_series',
    table: 'sensors',
    timeColumn: 'ts',
    interval: '5m',
    metrics: [metric()],
    ...overrides,
  };
}

describe('normalizeInterpolateMode', () => {
  it('keeps the canonical lowercase modes', () => {
    for (const mode of ['linear', 'prev', 'next', 'null', 'constant'] as const) {
      expect(normalizeInterpolateMode(mode)).toBe(mode);
    }
  });

  it('normalizes uppercase legacy values such as PREV / NEXT / NULL', () => {
    expect(normalizeInterpolateMode('PREV')).toBe('prev');
    expect(normalizeInterpolateMode('NEXT')).toBe('next');
    expect(normalizeInterpolateMode('NULL')).toBe('null');
    expect(normalizeInterpolateMode('LINEAR')).toBe('linear');
    expect(normalizeInterpolateMode('CONSTANT')).toBe('constant');
  });

  it('trims surrounding whitespace before comparing', () => {
    expect(normalizeInterpolateMode('  prev  ')).toBe('prev');
    expect(normalizeInterpolateMode('\tlinear\n')).toBe('linear');
  });

  it('falls back to linear for missing, blank or unknown modes', () => {
    expect(normalizeInterpolateMode()).toBe('linear');
    expect(normalizeInterpolateMode('')).toBe('linear');
    expect(normalizeInterpolateMode('   ')).toBe('linear');
    expect(normalizeInterpolateMode('quadratic')).toBe('linear');
  });
});

describe('buildDownsamplingSql', () => {
  it('builds the canonical downsampling statement', () => {
    const sql = buildDownsamplingSql(query({ tags: ['device_id'] }));
    expect(sql).toBe(
      [
        `SELECT time_bucket("ts", '5m') AS "time",`,
        `       "device_id",`,
        `       avg("temperature") AS "avg_temperature"`,
        'FROM "sensors"',
        TIME_MACROS,
        'GROUP BY "time", "device_id"',
        'ORDER BY "time", "device_id"',
      ].join('\n')
    );
  });

  it('uses time_bucket and injects the Grafana time macros', () => {
    const sql = buildDownsamplingSql(query());
    expect(sql).toContain(`SELECT time_bucket("ts", '5m') AS "time"`);
    expect(sql).toContain(TIME_MACROS);
    expect(sql).not.toContain('time_bucket_gapfill');
  });

  it('defaults the interval to 5m when it is missing, empty or blank', () => {
    expect(buildDownsamplingSql(query({ interval: undefined }))).toContain(`time_bucket("ts", '5m')`);
    expect(buildDownsamplingSql(query({ interval: '' }))).toContain(`time_bucket("ts", '5m')`);
    expect(buildDownsamplingSql(query({ interval: '   ' }))).toContain(`time_bucket("ts", '5m')`);
  });

  it('honours a custom interval', () => {
    expect(buildDownsamplingSql(query({ interval: '15m' }))).toContain(`time_bucket("ts", '15m')`);
    expect(buildDownsamplingSql(query({ interval: '90s' }))).toContain(`time_bucket("ts", '90s')`);
  });

  it('emits one aliased expression per metric using generated aliases', () => {
    const sql = buildDownsamplingSql(
      query({
        metrics: [
          { column: 'temperature', aggregation: 'avg' },
          { column: 'humidity', aggregation: 'sum' },
          { column: 'events', aggregation: 'count' },
          { column: 'voltage', aggregation: 'min' },
        ],
      })
    );
    expect(sql).toContain(`avg("temperature") AS "avg_temperature"`);
    expect(sql).toContain(`sum("humidity") AS "sum_humidity"`);
    expect(sql).toContain(`count("events") AS "count_events"`);
    expect(sql).toContain(`min("voltage") AS "min_voltage"`);
  });

  it('keeps a bare quoted column when aggregation is none and no alias is set', () => {
    const sql = buildDownsamplingSql(query({ metrics: [{ column: 'voltage', aggregation: 'none' }] }));
    expect(sql).toContain(`       "voltage"`);
    expect(sql).not.toContain(`none("voltage")`);
    expect(sql).not.toContain('"voltage" AS');
  });

  it('aliases a none-aggregated column when an alias is provided', () => {
    const sql = buildDownsamplingSql(query({ metrics: [{ column: 'voltage', aggregation: 'none', alias: 'volts' }] }));
    expect(sql).toContain(`"voltage" AS "volts"`);
  });

  it('prefers an explicit alias over the generated one', () => {
    const sql = buildDownsamplingSql(query({ metrics: [metric({ alias: 'mean_temp' })] }));
    expect(sql).toContain(`avg("temperature") AS "mean_temp"`);
    expect(sql).not.toContain('avg_temperature');
  });

  it('ignores whitespace-only aliases', () => {
    const sql = buildDownsamplingSql(query({ metrics: [metric({ alias: '   ' })] }));
    expect(sql).toContain(`avg("temperature") AS "avg_temperature"`);
  });

  it('groups and orders by every tag column', () => {
    const sql = buildDownsamplingSql(query({ tags: ['device_id', 'location'] }));
    expect(sql).toContain('GROUP BY "time", "device_id", "location"');
    expect(sql).toContain('ORDER BY "time", "device_id", "location"');
    const selectBlock = sql.split('FROM')[0];
    expect(selectBlock).toContain(`       "device_id",`);
    expect(selectBlock).toContain(`       "location"`);
  });

  it('drops blank tag entries', () => {
    const sql = buildDownsamplingSql(query({ tags: ['device_id', '   ', ''] }));
    expect(sql).toContain('GROUP BY "time", "device_id"');
    expect(sql).toContain('ORDER BY "time", "device_id"');
    expect(sql).not.toContain('""');
  });

  it('omits tags from GROUP BY / ORDER BY when none are configured', () => {
    const sql = buildDownsamplingSql(query({ tags: [] }));
    expect(sql).toContain('GROUP BY "time"');
    expect(sql).toContain('ORDER BY "time"');
  });

  it('escapes double quotes inside identifiers', () => {
    const sql = buildDownsamplingSql(
      query({
        table: 'sen"sors',
        timeColumn: 't"s',
        tags: ['de"vice'],
        metrics: [{ column: 'tem"p', aggregation: 'avg', alias: 'a"lias' }],
      })
    );
    expect(sql).toContain('FROM "sen""sors"');
    expect(sql).toContain(`"t""s" >= $__timeFrom`);
    expect(sql).toContain(`time_bucket("t""s", '5m')`);
    expect(sql).toContain(`       "de""vice"`);
    expect(sql).toContain(`avg("tem""p") AS "a""lias"`);
  });

  it('quotes every part of a schema-qualified table name', () => {
    const sql = buildDownsamplingSql(query({ table: 'iot.sensors' }));
    expect(sql).toContain('FROM "iot"."sensors"');
  });

  it('cannot be broken out of through a hostile column name', () => {
    const payload = 'x" ) AS evil --';
    const sql = buildDownsamplingSql(query({ metrics: [{ column: payload, aggregation: 'avg' }] }));
    // The payload is confined to a quoted identifier with doubled quotes.
    expect(sql).toContain(`avg("x"" ) AS evil --")`);
    expect(sql).not.toContain(payload);
    expect(sql.startsWith('SELECT ')).toBe(true);
  });

  it('cannot be broken out of through a hostile table name', () => {
    const sql = buildDownsamplingSql(query({ table: 'sensors"; DROP TABLE secrets; --' }));
    expect(sql).toContain('FROM "sensors""; DROP TABLE secrets; --"');
    expect(sql).not.toContain('\nDROP');
    expect(sql.split('\n')).toHaveLength(6);
  });

  it('trims the table and the tags', () => {
    const sql = buildDownsamplingSql(query({ table: '  sensors  ', tags: ['  device_id  '] }));
    expect(sql).toContain('FROM "sensors"');
    expect(sql).toContain(`       "device_id"`);
    expect(sql).toContain('GROUP BY "time", "device_id"');
  });

  it('trims the time column and the metric column so SELECT and WHERE agree', () => {
    const sql = buildDownsamplingSql(query({ timeColumn: '  ts  ', metrics: [metric({ column: ' temperature ' })] }));
    expect(sql).toContain(`time_bucket("ts", '5m')`);
    expect(sql).toContain(TIME_MACROS);
    expect(sql).toContain(`avg("temperature") AS "avg_temperature"`);
  });

  it('returns an empty string when the table is missing', () => {
    expect(buildDownsamplingSql(query({ table: undefined }))).toBe('');
    expect(buildDownsamplingSql(query({ table: '   ' }))).toBe('');
  });

  it('returns an empty string when the time column is missing', () => {
    expect(buildDownsamplingSql(query({ timeColumn: undefined }))).toBe('');
    expect(buildDownsamplingSql(query({ timeColumn: '' }))).toBe('');
  });

  it('returns an empty string when there are no usable metrics', () => {
    expect(buildDownsamplingSql(query({ metrics: [] }))).toBe('');
    expect(buildDownsamplingSql(query({ metrics: undefined }))).toBe('');
    expect(buildDownsamplingSql(query({ metrics: [{ column: '   ', aggregation: 'avg' }] }))).toBe('');
  });
});

describe('buildGapfillSql', () => {
  it('builds the canonical gapfill statement', () => {
    const sql = buildGapfillSql(query({ mode: 'gapfill', tags: ['device_id'] }));
    expect(sql).toBe(
      [
        `SELECT time_bucket_gapfill("ts", '5m') AS "time",`,
        `       "device_id",`,
        `       interpolate(avg("temperature"), 'linear') AS "avg_temperature"`,
        'FROM "sensors"',
        TIME_MACROS,
        'GROUP BY "time", "device_id"',
        'ORDER BY "time", "device_id"',
      ].join('\n')
    );
  });

  it('normalizes uppercase interpolate modes to lowercase quoted literals', () => {
    // Older dashboards may still store the uppercase spellings, so they are cast here
    // to reach normalizeInterpolateMode the same way untyped dashboard JSON would.
    const legacy = (value: string) => value as KwdbInterpolateMode;
    expect(buildGapfillSql(query({ mode: 'gapfill', interpolateMode: legacy('PREV') }))).toContain(
      `interpolate(avg("temperature"), 'prev')`
    );
    expect(buildGapfillSql(query({ mode: 'gapfill', interpolateMode: legacy('NEXT') }))).toContain(
      `interpolate(avg("temperature"), 'next')`
    );
    expect(buildGapfillSql(query({ mode: 'gapfill', interpolateMode: legacy('NULL') }))).toContain(
      `interpolate(avg("temperature"), 'null')`
    );
  });

  it('renders the constant mode as a numeric literal', () => {
    const sql = buildGapfillSql(query({ mode: 'gapfill', interpolateMode: 'constant', interpolateConstant: 7 }));
    expect(sql).toContain(`interpolate(avg("temperature"), 7)`);
    expect(sql).not.toContain(`interpolate(avg("temperature"), '7')`);
  });

  it('defaults the constant fill value to 0', () => {
    const sql = buildGapfillSql(query({ mode: 'gapfill', interpolateMode: 'constant' }));
    expect(sql).toContain(`interpolate(avg("temperature"), 0)`);
  });

  it('coerces a non-finite constant to 0', () => {
    const nan = buildGapfillSql(query({ mode: 'gapfill', interpolateMode: 'constant', interpolateConstant: NaN }));
    expect(nan).toContain(`interpolate(avg("temperature"), 0)`);
    const infinite = buildGapfillSql(
      query({ mode: 'gapfill', interpolateMode: 'constant', interpolateConstant: Number.POSITIVE_INFINITY })
    );
    expect(infinite).toContain(`interpolate(avg("temperature"), 0)`);
  });

  it('accepts a negative constant', () => {
    const sql = buildGapfillSql(query({ mode: 'gapfill', interpolateMode: 'constant', interpolateConstant: -1.5 }));
    expect(sql).toContain(`interpolate(avg("temperature"), -1.5)`);
  });

  it('falls back to linear for an unknown interpolate mode', () => {
    const sql = buildGapfillSql(query({ mode: 'gapfill', interpolateMode: 'quadratic' as 'linear' }));
    expect(sql).toContain(`interpolate(avg("temperature"), 'linear')`);
  });

  it('supports aliases and none-aggregated columns inside interpolate()', () => {
    const aliased = buildGapfillSql(query({ mode: 'gapfill', metrics: [metric({ alias: 'filled' })] }));
    expect(aliased).toContain(`interpolate(avg("temperature"), 'linear') AS "filled"`);

    const raw = buildGapfillSql(query({ mode: 'gapfill', metrics: [{ column: 'voltage', aggregation: 'none' }] }));
    expect(raw).toContain(`interpolate("voltage", 'linear')`);
    expect(raw).not.toContain(`"voltage" AS`);
  });

  it('returns an empty string when the table, time column or metrics are missing', () => {
    expect(buildGapfillSql(query({ mode: 'gapfill', table: undefined }))).toBe('');
    expect(buildGapfillSql(query({ mode: 'gapfill', timeColumn: undefined }))).toBe('');
    expect(buildGapfillSql(query({ mode: 'gapfill', metrics: [] }))).toBe('');
  });
});

describe('buildLatestSql', () => {
  it('builds the canonical latest-values statement', () => {
    const sql = buildLatestSql(query({ mode: 'latest', tags: ['device_id'] }));
    expect(sql).toBe(
      [
        `SELECT "device_id",`,
        `       last("temperature") AS "latest_temperature",`,
        `       last("ts") AS "time"`,
        'FROM "sensors"',
        TIME_MACROS,
        'GROUP BY "device_id"',
      ].join('\n')
    );
  });

  it('uses last() by default', () => {
    const sql = buildLatestSql(query({ mode: 'latest' }));
    expect(sql).toContain(`last("temperature") AS "latest_temperature"`);
    expect(sql).toContain(`last("ts") AS "time"`);
  });

  it('maps first and first_row onto first() for the time column', () => {
    const first = buildLatestSql(query({ mode: 'latest', latestFunc: 'first' }));
    expect(first).toContain(`first("temperature") AS "latest_temperature"`);
    expect(first).toContain(`first("ts") AS "time"`);

    const firstRow = buildLatestSql(query({ mode: 'latest', latestFunc: 'first_row' }));
    expect(firstRow).toContain(`first_row("temperature") AS "latest_temperature"`);
    expect(firstRow).toContain(`first("ts") AS "time"`);
  });

  it('keeps last_row for the metric column but falls back to last() for the time column', () => {
    // Documents the current behaviour: last_row() includes NULL rows while last(ts)
    // skips them, so the reported time can come from a different row than the value.
    const sql = buildLatestSql(query({ mode: 'latest', latestFunc: 'last_row' }));
    expect(sql).toContain(`last_row("temperature") AS "latest_temperature"`);
    expect(sql).toContain(`last("ts") AS "time"`);
  });

  it('honours an explicit metric alias', () => {
    const sql = buildLatestSql(query({ mode: 'latest', metrics: [metric({ alias: 'current_temp' })] }));
    expect(sql).toContain(`last("temperature") AS "current_temp"`);
    expect(sql).not.toContain('latest_temperature');
  });

  it('groups by tags only when tags are configured', () => {
    expect(buildLatestSql(query({ mode: 'latest', tags: ['device_id', 'location'] }))).toContain(
      'GROUP BY "device_id", "location"'
    );
    const withoutTags = buildLatestSql(query({ mode: 'latest', tags: [] }));
    expect(withoutTags).not.toContain('GROUP BY');
  });

  it('has no ORDER BY clause', () => {
    expect(buildLatestSql(query({ mode: 'latest', tags: ['device_id'] }))).not.toContain('ORDER BY');
  });

  it('returns an empty string when the table, time column or metrics are missing', () => {
    expect(buildLatestSql(query({ mode: 'latest', table: undefined }))).toBe('');
    expect(buildLatestSql(query({ mode: 'latest', timeColumn: undefined }))).toBe('');
    expect(buildLatestSql(query({ mode: 'latest', metrics: [] }))).toBe('');
  });
});

describe('buildWindowSql', () => {
  it('builds the canonical TIME_WINDOW statement with the default 1h interval', () => {
    const sql = buildWindowSql(query({ mode: 'window', windowType: 'TIME_WINDOW', tags: ['device_id'] }));
    expect(sql).toBe(
      [
        `SELECT first("ts") AS "time",`,
        `       "device_id",`,
        `       avg("temperature") AS "avg_temperature"`,
        'FROM "sensors"',
        TIME_MACROS,
        `GROUP BY "device_id", TIME_WINDOW("ts", '1h')`,
        'ORDER BY "time", "device_id"',
      ].join('\n')
    );
  });

  it('adds the slide interval to TIME_WINDOW', () => {
    const sql = buildWindowSql(
      query({ mode: 'window', windowType: 'TIME_WINDOW', windowInterval: '1h', windowSlide: '15m' })
    );
    expect(sql).toContain(`GROUP BY TIME_WINDOW("ts", '1h', '15m')`);
  });

  it('ignores a blank slide interval', () => {
    const sql = buildWindowSql(query({ mode: 'window', windowType: 'TIME_WINDOW', windowSlide: '   ' }));
    expect(sql).toContain(`GROUP BY TIME_WINDOW("ts", '1h')`);
    expect(sql).not.toContain("'   '");
  });

  it('uses a 5m default for SESSION_WINDOW and ignores the slide', () => {
    const sql = buildWindowSql(query({ mode: 'window', windowType: 'SESSION_WINDOW', windowSlide: '15m' }));
    expect(sql).toContain(`GROUP BY SESSION_WINDOW("ts", '5m')`);
    expect(sql).not.toContain('15m');
  });

  it('renders EVENT_WINDOW conditions verbatim', () => {
    const sql = buildWindowSql(
      query({
        mode: 'window',
        windowType: 'EVENT_WINDOW',
        eventStartCond: 'temperature > 100',
        eventEndCond: 'temperature <= 100',
      })
    );
    expect(sql).toContain('GROUP BY EVENT_WINDOW(temperature > 100, temperature <= 100)');
  });

  it('returns an empty string for EVENT_WINDOW without both conditions', () => {
    expect(
      buildWindowSql(query({ mode: 'window', windowType: 'EVENT_WINDOW', eventStartCond: 'temperature > 100' }))
    ).toBe('');
    expect(
      buildWindowSql(query({ mode: 'window', windowType: 'EVENT_WINDOW', eventEndCond: 'temperature <= 100' }))
    ).toBe('');
    expect(
      buildWindowSql(query({ mode: 'window', windowType: 'EVENT_WINDOW', eventStartCond: '  ', eventEndCond: '  ' }))
    ).toBe('');
  });

  it('renders COUNT_WINDOW with and without a slide', () => {
    expect(buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '10' }))).toContain(
      'GROUP BY COUNT_WINDOW(10)'
    );
    expect(
      buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '10', windowSlide: '5' }))
    ).toContain('GROUP BY COUNT_WINDOW(10, 5)');
  });

  it('defaults the COUNT_WINDOW row limit to 100, matching the editor field', () => {
    // The editor renders "Row limit" with an initial value of 100 while the query
    // model still has windowInterval undefined. The statement must agree with what
    // the user sees, and must not depend on the field being touched.
    expect(buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW' }))).toContain(
      'GROUP BY COUNT_WINDOW(100)'
    );
    expect(buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '  ' }))).toContain(
      'GROUP BY COUNT_WINDOW(100)'
    );
  });

  it('rejects a non-numeric COUNT_WINDOW row limit', () => {
    expect(buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: 'ten' }))).toBe('');
    expect(
      buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '10; DROP TABLE sensors' }))
    ).toBe('');
  });

  it('renders STATE_WINDOW from the start condition', () => {
    const sql = buildWindowSql(query({ mode: 'window', windowType: 'STATE_WINDOW', eventStartCond: 'status' }));
    expect(sql).toContain('GROUP BY STATE_WINDOW(status)');
  });

  it('returns an empty string for STATE_WINDOW without an expression', () => {
    expect(buildWindowSql(query({ mode: 'window', windowType: 'STATE_WINDOW' }))).toBe('');
    expect(buildWindowSql(query({ mode: 'window', windowType: 'STATE_WINDOW', eventStartCond: '   ' }))).toBe('');
  });

  it('returns an empty string for an unknown or missing window type', () => {
    expect(buildWindowSql(query({ mode: 'window' }))).toBe('');
    expect(buildWindowSql(query({ mode: 'window', windowType: 'MYSTERY_WINDOW' as 'TIME_WINDOW' }))).toBe('');
  });

  it('returns an empty string when the table, time column or metrics are missing', () => {
    expect(buildWindowSql(query({ mode: 'window', windowType: 'TIME_WINDOW', table: undefined }))).toBe('');
    expect(buildWindowSql(query({ mode: 'window', windowType: 'TIME_WINDOW', timeColumn: undefined }))).toBe('');
    expect(buildWindowSql(query({ mode: 'window', windowType: 'TIME_WINDOW', metrics: [] }))).toBe('');
  });

  it('groups by the window expression alone when no tags are configured', () => {
    const sql = buildWindowSql(query({ mode: 'window', windowType: 'TIME_WINDOW', tags: [] }));
    expect(sql).toContain(`GROUP BY TIME_WINDOW("ts", '1h')`);
    expect(sql).toContain('ORDER BY "time"');
  });

  it('rejects event conditions that could terminate the statement or open a comment', () => {
    // The free-form fragments are spliced into the statement, so anything that
    // could break out of the GROUP BY list is refused instead of emitted.
    const injected = buildWindowSql(
      query({
        mode: 'window',
        windowType: 'EVENT_WINDOW',
        eventStartCond: 'temperature > 100) OR 1=1 --',
        eventEndCond: 'temperature <= 100',
      })
    );
    expect(injected).toBe('');

    const semicolon = buildWindowSql(
      query({
        mode: 'window',
        windowType: 'STATE_WINDOW',
        eventStartCond: 'status = 1; DROP TABLE sensors',
      })
    );
    expect(semicolon).toBe('');

    const comment = buildWindowSql(
      query({ mode: 'window', windowType: 'STATE_WINDOW', eventStartCond: 'status = 1 /* x */' })
    );
    expect(comment).toBe('');
  });

  it('requires numeric COUNT_WINDOW arguments', () => {
    expect(buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '10' }))).toContain(
      'GROUP BY COUNT_WINDOW(10)'
    );
    expect(
      buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '10', windowSlide: '5' }))
    ).toContain('GROUP BY COUNT_WINDOW(10, 5)');
    expect(
      buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '10; DROP TABLE sensors' }))
    ).toBe('');
    expect(
      buildWindowSql(
        query({
          mode: 'window',
          windowType: 'COUNT_WINDOW',
          windowInterval: '10',
          windowSlide: '5; DROP TABLE sensors',
        })
      )
    ).toBe('');
  });

  it('selects the window start with first() on the time column', () => {
    const sql = buildWindowSql(query({ mode: 'window', windowType: 'COUNT_WINDOW', windowInterval: '10' }));
    expect(sql).toContain(`SELECT first("ts") AS "time"`);
    expect(sql).not.toContain('time_bucket');
  });
});

describe('buildRawSql', () => {
  it('returns the raw SQL unchanged', () => {
    const rawSql = 'SELECT 1\nFROM sensors;\n';
    expect(buildRawSql(query({ mode: 'raw', rawSql }))).toBe(rawSql);
  });

  it('does not trim the raw SQL', () => {
    expect(buildRawSql(query({ mode: 'raw', rawSql: '   SELECT 1   ' }))).toBe('   SELECT 1   ');
  });

  it('returns an empty string when no raw SQL is set', () => {
    expect(buildRawSql(query({ mode: 'raw' }))).toBe('');
    expect(buildRawSql(query({ mode: 'raw', rawSql: undefined }))).toBe('');
  });
});

describe('buildSql', () => {
  it('dispatches to the gapfill builder', () => {
    const q = query({ mode: 'gapfill' });
    expect(buildSql(q)).toBe(buildGapfillSql(q));
    expect(buildSql(q)).toContain('time_bucket_gapfill');
  });

  it('dispatches to the latest builder', () => {
    const q = query({ mode: 'latest' });
    expect(buildSql(q)).toBe(buildLatestSql(q));
    expect(buildSql(q)).toContain('last("temperature") AS "latest_temperature"');
  });

  it('dispatches to the window builder', () => {
    const q = query({ mode: 'window', windowType: 'SESSION_WINDOW' });
    expect(buildSql(q)).toBe(buildWindowSql(q));
    expect(buildSql(q)).toContain('SESSION_WINDOW');
  });

  it('dispatches to the raw SQL builder', () => {
    const q = query({ mode: 'raw', rawSql: 'SELECT 1' });
    expect(buildSql(q)).toBe('SELECT 1');
  });

  it('dispatches to the downsampling builder for downsampling mode', () => {
    const q = query({ mode: 'downsampling' });
    expect(buildSql(q)).toBe(buildDownsamplingSql(q));
    expect(buildSql(q)).toContain('time_bucket("ts"');
  });

  it('falls back to downsampling for an unknown mode', () => {
    const q = query({ mode: 'mystery' as 'downsampling' });
    expect(buildSql(q)).toBe(buildDownsamplingSql(q));
  });

  it('ignores format and splitByTag because they only shape frames downstream', () => {
    const timeSeries = buildSql(query({ mode: 'downsampling', format: 'time_series' }));
    const table = buildSql(query({ mode: 'downsampling', format: 'table' }));
    const split = buildSql(query({ mode: 'latest', format: 'time_series', splitByTag: true, tags: ['device_id'] }));
    const merged = buildSql(query({ mode: 'latest', format: 'table', splitByTag: false, tags: ['device_id'] }));
    expect(table).toBe(timeSeries);
    expect(merged).toBe(split);
    expect(timeSeries).not.toMatch(/\bformat\b|\blong\b/);
  });

  it('injects the time macros in every builder mode except raw', () => {
    const modes = [
      query({ mode: 'downsampling' }),
      query({ mode: 'gapfill' }),
      query({ mode: 'latest' }),
      query({ mode: 'window', windowType: 'TIME_WINDOW' }),
    ];
    for (const q of modes) {
      expect(buildSql(q)).toContain('$__timeFrom');
      expect(buildSql(q)).toContain('$__timeTo');
    }
    expect(buildSql(query({ mode: 'raw', rawSql: 'SELECT 1' }))).not.toContain('$__timeFrom');
  });
});
