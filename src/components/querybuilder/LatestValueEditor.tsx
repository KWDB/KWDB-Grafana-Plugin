import React from 'react';
import { Alert, Button, InlineField, InlineFieldRow, InlineSwitch, Select, VerticalGroup } from '@grafana/ui';

import type { KwdbDataSource } from '../../datasource';
import { buildSql } from '../../sqlBuilder';
import type { KwdbQuery, MetricSpec } from '../../types';
import { SqlPreview } from './SqlPreview';
import { ColumnPicker } from './shared/ColumnPicker';
import { MetricRow } from './shared/MetricRow';
import { tableChangePatch } from './shared/queryChanges';
import { TableSelector } from './shared/TableSelector';
import { TimeColumnPicker } from './shared/TimeColumnPicker';
import { useTableColumns } from './shared/useTableColumns';

const LATEST_FUNCS: Array<NonNullable<KwdbQuery['latestFunc']>> = ['last', 'last_row', 'first', 'first_row'];

interface Props {
  datasource: KwdbDataSource;
  query: KwdbQuery;
  onChange: (query: KwdbQuery) => void;
}

export function LatestValueEditor({ datasource, query, onChange }: Props) {
  const columns = useTableColumns(datasource, query.table);
  const splitByTag = query.splitByTag ?? true;

  const updateQuery = (patch: Partial<KwdbQuery>) => {
    const next = { ...query, ...patch };
    next.rawSql = buildSql(next);
    onChange(next);
  };

  const metrics: MetricSpec[] = query.metrics?.length ? query.metrics : [{ column: '', aggregation: 'none' }];

  const updateMetric = (index: number, metric: MetricSpec) => {
    updateQuery({ metrics: metrics.map((item, itemIndex) => (itemIndex === index ? metric : item)) });
  };

  const removeMetric = (index: number) => {
    if (metrics.length <= 1) {
      return;
    }
    updateQuery({ metrics: metrics.filter((_, itemIndex) => itemIndex !== index) });
  };

  return (
    <VerticalGroup spacing="md">
      <InlineField label="Table" labelWidth={12}>
        <TableSelector
          datasource={datasource}
          value={query.table}
          onChange={(table) => {
            const patch = tableChangePatch(table, query.table);
            if (patch) {
              updateQuery(patch);
            }
          }}
        />
      </InlineField>
      <InlineField label="Time column" labelWidth={12}>
        <TimeColumnPicker
          columns={columns}
          value={query.timeColumn}
          onChange={(timeColumn) => updateQuery({ timeColumn })}
        />
      </InlineField>
      <InlineFieldRow>
        <InlineField label="Latest function" labelWidth={16}>
          <Select<NonNullable<KwdbQuery['latestFunc']>>
            aria-label="Latest function"
            options={LATEST_FUNCS.map((func) => ({ label: func, value: func }))}
            value={query.latestFunc ?? 'last'}
            onChange={(item) => updateQuery({ latestFunc: item.value ?? 'last' })}
            width={20}
            menuShouldPortal={false}
          />
        </InlineField>
        {(query.tags?.length ?? 0) > 0 && (
          <InlineField
            label="Split per tag"
            labelWidth={14}
            tooltip="Split results into one series per tag combination. Disable to return one merged table frame."
          >
            <InlineSwitch
              aria-label="Split per tag"
              value={splitByTag}
              onChange={(event) => updateQuery({ splitByTag: event.currentTarget.checked })}
            />
          </InlineField>
        )}
      </InlineFieldRow>
      <InlineField label="Tags" labelWidth={12}>
        <ColumnPicker columns={columns} value={query.tags ?? []} onChange={(tags) => updateQuery({ tags })} />
      </InlineField>
      <InlineField label="Metrics" labelWidth={12}>
        <VerticalGroup spacing="sm">
          {metrics.map((metric, index) => (
            <MetricRow
              key={index}
              index={index}
              columns={columns}
              metric={metric}
              hideAggregation
              onChange={(nextMetric) => updateMetric(index, nextMetric)}
              onRemove={metrics.length > 1 ? () => removeMetric(index) : undefined}
            />
          ))}
          <Button
            icon="plus-circle"
            variant="secondary"
            size="sm"
            onClick={() => updateQuery({ metrics: [...metrics, { column: '', aggregation: 'none' }] })}
          >
            Add metric
          </Button>
        </VerticalGroup>
      </InlineField>
      {(query.tags?.length ?? 0) > 0 &&
        (splitByTag ? (
          <Alert severity="info" title="One series per tag value" aria-label="Latest values splitting hint">
            Results are split into one series per tag combination, so Stat and Gauge panels show every device
            separately. Disable &quot;Split per tag&quot; to return a single merged table frame.
          </Alert>
        ) : (
          <Alert severity="info" title="Merged table frame" aria-label="Latest values merging hint">
            All tag combinations are returned as one merged frame. Enable &quot;Split per tag&quot; so Stat and Gauge
            panels show every device separately.
          </Alert>
        ))}
      <SqlPreview sql={query.rawSql ?? ''} />
    </VerticalGroup>
  );
}
