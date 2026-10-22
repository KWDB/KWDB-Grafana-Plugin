import React from 'react';
import { Button, InlineField, Input, Select, VerticalGroup } from '@grafana/ui';

import type { KwdbDataSource } from '../../datasource';
import { buildSql } from '../../sqlBuilder';
import type { KwdbQuery, MetricSpec } from '../../types';
import { SqlPreview } from './SqlPreview';
import { ColumnPicker } from './shared/ColumnPicker';
import { MetricRow } from './shared/MetricRow';
import { tableChangePatch, windowTypeChangePatch } from './shared/queryChanges';
import { TableSelector } from './shared/TableSelector';
import { TimeColumnPicker } from './shared/TimeColumnPicker';
import { useTableColumns } from './shared/useTableColumns';

const WINDOW_TYPES: Array<NonNullable<KwdbQuery['windowType']>> = [
  'TIME_WINDOW',
  'SESSION_WINDOW',
  'EVENT_WINDOW',
  'COUNT_WINDOW',
  'STATE_WINDOW',
];

interface Props {
  datasource: KwdbDataSource;
  query: KwdbQuery;
  onChange: (query: KwdbQuery) => void;
}

export function WindowEventEditor({ datasource, query, onChange }: Props) {
  const columns = useTableColumns(datasource, query.table);
  const windowType = query.windowType ?? 'TIME_WINDOW';

  const updateQuery = (patch: Partial<KwdbQuery>) => {
    const next = { ...query, ...patch };
    next.rawSql = buildSql(next);
    onChange(next);
  };

  const metrics: MetricSpec[] = query.metrics?.length ? query.metrics : [{ column: '', aggregation: 'avg' }];

  const updateMetric = (index: number, metric: MetricSpec) => {
    updateQuery({ metrics: metrics.map((item, itemIndex) => (itemIndex === index ? metric : item)) });
  };

  const removeMetric = (index: number) => {
    if (metrics.length <= 1) {
      return;
    }
    updateQuery({ metrics: metrics.filter((_, itemIndex) => itemIndex !== index) });
  };

  const renderWindowFields = () => {
    switch (windowType) {
      case 'TIME_WINDOW':
        return (
          <>
            <InlineField label="Window interval" labelWidth={12}>
              <Input
                aria-label="Window interval"
                value={query.windowInterval ?? '1h'}
                onChange={(event) => updateQuery({ windowInterval: event.currentTarget.value })}
                placeholder="e.g. 1h"
                width={24}
              />
            </InlineField>
            <InlineField label="Slide interval" labelWidth={12}>
              <Input
                aria-label="Slide interval"
                value={query.windowSlide ?? ''}
                onChange={(event) => updateQuery({ windowSlide: event.currentTarget.value })}
                placeholder="e.g. 15m"
                width={24}
              />
            </InlineField>
          </>
        );
      case 'SESSION_WINDOW':
        return (
          <InlineField label="Session threshold" labelWidth={12}>
            <Input
              aria-label="Session threshold"
              value={query.windowInterval ?? '5m'}
              onChange={(event) => updateQuery({ windowInterval: event.currentTarget.value })}
              placeholder="e.g. 5m"
              width={24}
            />
          </InlineField>
        );
      case 'EVENT_WINDOW':
        return (
          <>
            <InlineField label="Event start condition" labelWidth={12}>
              <Input
                aria-label="Event start condition"
                value={query.eventStartCond ?? ''}
                onChange={(event) => updateQuery({ eventStartCond: event.currentTarget.value })}
                placeholder="e.g. temperature > 100"
                width={40}
              />
            </InlineField>
            <InlineField label="Event end condition" labelWidth={12}>
              <Input
                aria-label="Event end condition"
                value={query.eventEndCond ?? ''}
                onChange={(event) => updateQuery({ eventEndCond: event.currentTarget.value })}
                placeholder="e.g. temperature <= 100"
                width={40}
              />
            </InlineField>
          </>
        );
      case 'COUNT_WINDOW':
        return (
          <>
            <InlineField label="Row limit" labelWidth={12}>
              <Input
                aria-label="Row limit"
                value={query.windowInterval ?? '100'}
                onChange={(event) => updateQuery({ windowInterval: event.currentTarget.value })}
                placeholder="e.g. 100"
                width={24}
              />
            </InlineField>
            <InlineField label="Slide rows" labelWidth={12}>
              <Input
                aria-label="Slide rows"
                value={query.windowSlide ?? ''}
                onChange={(event) => updateQuery({ windowSlide: event.currentTarget.value })}
                placeholder="e.g. 10"
                width={24}
              />
            </InlineField>
          </>
        );
      case 'STATE_WINDOW':
        return (
          <InlineField label="State expression" labelWidth={12}>
            <Input
              aria-label="State expression"
              value={query.eventStartCond ?? ''}
              onChange={(event) => updateQuery({ eventStartCond: event.currentTarget.value })}
              placeholder="e.g. CASE WHEN voltage >= 225 THEN 1 ELSE 0 END"
              width={40}
            />
          </InlineField>
        );
      default:
        return null;
    }
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
      <InlineField label="Window type" labelWidth={12}>
        <Select<NonNullable<KwdbQuery['windowType']>>
          aria-label="Window type"
          options={WINDOW_TYPES.map((type) => ({ label: type, value: type }))}
          value={windowType}
          onChange={(item) => {
            const patch = windowTypeChangePatch(item.value ?? 'TIME_WINDOW', windowType);
            if (patch) {
              updateQuery(patch);
            }
          }}
          width={24}
          menuShouldPortal={false}
        />
      </InlineField>
      {renderWindowFields()}
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
              onChange={(nextMetric) => updateMetric(index, nextMetric)}
              onRemove={metrics.length > 1 ? () => removeMetric(index) : undefined}
            />
          ))}
          <Button
            icon="plus-circle"
            variant="secondary"
            size="sm"
            onClick={() => updateQuery({ metrics: [...metrics, { column: '', aggregation: 'avg' }] })}
          >
            Add metric
          </Button>
        </VerticalGroup>
      </InlineField>
      <SqlPreview sql={query.rawSql ?? ''} />
    </VerticalGroup>
  );
}
