import type { KwdbQuery } from '../src/types';

import { tableChangePatch, windowTypeChangePatch } from '../src/components/querybuilder/shared/queryChanges';

function query(overrides: Partial<KwdbQuery> = {}): KwdbQuery {
  return {
    refId: 'A',
    mode: 'window',
    format: 'time_series',
    table: 'sensors',
    timeColumn: 'ts',
    metrics: [{ column: 'temperature', aggregation: 'avg' }],
    ...overrides,
  };
}

describe('tableChangePatch', () => {
  it('returns undefined when the table did not change', () => {
    expect(tableChangePatch('sensors', 'sensors')).toBeUndefined();
  });

  it('drops every column reference when the table changes', () => {
    expect(tableChangePatch('devices', 'sensors')).toEqual({
      table: 'devices',
      timeColumn: undefined,
      tags: [],
      metrics: [],
    });
  });

  it('clears a previously configured time column, tags and metrics', () => {
    const before = query({ tags: ['device_id'], metrics: [{ column: 'temperature', aggregation: 'avg' }] });
    const patch = tableChangePatch('devices', before.table);

    expect(patch).toBeDefined();
    const after = { ...before, ...patch };
    expect(after.timeColumn).toBeUndefined();
    expect(after.tags).toEqual([]);
    expect(after.metrics).toEqual([]);
  });
});

describe('windowTypeChangePatch', () => {
  it('returns undefined when the window type did not change', () => {
    expect(windowTypeChangePatch('TIME_WINDOW', 'TIME_WINDOW')).toBeUndefined();
    expect(windowTypeChangePatch('TIME_WINDOW', undefined)).toBeUndefined();
    expect(windowTypeChangePatch('COUNT_WINDOW', 'COUNT_WINDOW')).toBeUndefined();
  });

  it('drops every window field when the type changes', () => {
    // windowInterval means a duration for TIME_WINDOW but a row count for
    // COUNT_WINDOW, so it must never survive the switch.
    expect(windowTypeChangePatch('COUNT_WINDOW', 'TIME_WINDOW')).toEqual({
      windowType: 'COUNT_WINDOW',
      windowInterval: undefined,
      windowSlide: undefined,
      eventStartCond: undefined,
      eventEndCond: undefined,
    });
  });

  it('clears a previously configured duration and conditions', () => {
    const before = query({
      windowType: 'TIME_WINDOW',
      windowInterval: '1h',
      windowSlide: '15m',
      eventStartCond: 'temperature > 100',
      eventEndCond: 'temperature <= 100',
    });
    const patch = windowTypeChangePatch('SESSION_WINDOW', before.windowType);

    expect(patch).toBeDefined();
    const after = { ...before, ...patch };
    expect(after.windowType).toBe('SESSION_WINDOW');
    expect(after.windowInterval).toBeUndefined();
    expect(after.windowSlide).toBeUndefined();
    expect(after.eventStartCond).toBeUndefined();
    expect(after.eventEndCond).toBeUndefined();
  });

  it('keeps the table, time column, tags and metrics untouched', () => {
    const before = query({ windowType: 'TIME_WINDOW', tags: ['device_id'] });
    const after = { ...before, ...windowTypeChangePatch('EVENT_WINDOW', before.windowType) };

    expect(after.table).toBe('sensors');
    expect(after.timeColumn).toBe('ts');
    expect(after.tags).toEqual(['device_id']);
    expect(after.metrics).toEqual([{ column: 'temperature', aggregation: 'avg' }]);
  });
});
