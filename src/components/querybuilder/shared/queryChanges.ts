import type { KwdbQuery } from '../../../types';

/**
 * Column references are table-specific, so switching tables must drop every
 * field that points at a column of the previous table. Returns undefined when
 * the table did not actually change, so re-selecting it keeps the columns.
 */
export function tableChangePatch(table: string, currentTable?: string): Partial<KwdbQuery> | undefined {
  if (table === (currentTable ?? '')) {
    return undefined;
  }
  return {
    table,
    timeColumn: undefined,
    tags: [],
    metrics: [],
  };
}

/**
 * Window fields have different meanings per window type (`windowInterval` is a
 * duration for TIME_WINDOW but a row count for COUNT_WINDOW), so they must not
 * survive a window type change. The SQL builder returns an empty statement
 * until the fields required by the new type are filled in. Returns undefined
 * when the type did not actually change.
 */
export function windowTypeChangePatch(
  windowType: NonNullable<KwdbQuery['windowType']>,
  currentWindowType?: KwdbQuery['windowType']
): Partial<KwdbQuery> | undefined {
  if (windowType === (currentWindowType ?? 'TIME_WINDOW')) {
    return undefined;
  }
  return {
    windowType,
    windowInterval: undefined,
    windowSlide: undefined,
    eventStartCond: undefined,
    eventEndCond: undefined,
  };
}
