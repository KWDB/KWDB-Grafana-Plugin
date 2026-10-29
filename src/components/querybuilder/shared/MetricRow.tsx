import React from 'react';
import { IconButton, Input, Select, Stack } from '@grafana/ui';

import type { ColumnInfo, MetricSpec } from '../../../types';
import { type MetricAggregation, getAggregationsForColumn } from './aggregations';
import { ColumnPicker } from './ColumnPicker';

interface Props {
  index: number;
  columns: ColumnInfo[];
  metric: MetricSpec;
  onChange: (metric: MetricSpec) => void;
  onRemove?: () => void;
  hideAggregation?: boolean;
  /**
   * Aggregations to leave out of the dropdown. Gapfill uses this to drop
   * "none": interpolate() requires an aggregate function as its first argument,
   * so a bare column produces "the first parameter of interpolate must be agg
   * func" from KWDB.
   */
  excludeAggregations?: MetricAggregation[];
}

export function MetricRow({ index, columns, metric, onChange, onRemove, hideAggregation, excludeAggregations }: Props) {
  const excluded = new Set(excludeAggregations ?? []);
  const aggregations = getAggregationsForColumn(columns, metric.column).filter(
    (aggregation) => !excluded.has(aggregation)
  );

  const handleColumnChange = (value: string[]) => {
    const column = value[0] ?? '';
    // Reset the aggregation when the newly selected column does not support it
    // (e.g. switching from a FLOAT8 to a VARCHAR or tag column).
    const allowed = getAggregationsForColumn(columns, column);
    const aggregation = allowed.includes(metric.aggregation) ? metric.aggregation : allowed[0];
    onChange({ ...metric, column, aggregation });
  };

  return (
    <Stack gap={1}>
      <ColumnPicker
        kind="metric"
        columns={columns}
        value={metric.column ? [metric.column] : []}
        onChange={handleColumnChange}
        ariaLabel={`Metric column ${index}`}
        width={20}
      />
      {!hideAggregation && (
        <Select<MetricSpec['aggregation']>
          aria-label={`Aggregation ${index}`}
          options={aggregations.map((aggregation) => ({ label: aggregation, value: aggregation }))}
          value={{ label: metric.aggregation, value: metric.aggregation }}
          onChange={(item) => onChange({ ...metric, aggregation: item.value ?? 'avg' })}
          menuShouldPortal={false}
          width={16}
        />
      )}
      <Input
        aria-label={`Alias ${index}`}
        value={metric.alias ?? ''}
        onChange={(event) => onChange({ ...metric, alias: event.currentTarget.value })}
        placeholder="Alias (optional)"
        width={20}
      />
      {onRemove && <IconButton name="trash-alt" tooltip="Remove metric" onClick={onRemove} />}
    </Stack>
  );
}
