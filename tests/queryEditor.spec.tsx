import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { QueryEditor } from '../src/components/QueryEditor';
import type { KwdbDataSource } from '../src/datasource';
import type { ColumnInfo, KwdbQuery } from '../src/types';

jest.mock('@grafana/ui', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    CodeEditor: (props: { value?: string; onChange?: (value: string) => void; readOnly?: boolean }) =>
      ReactModule.createElement('textarea', {
        'aria-label': 'SQL',
        'data-testid': props.readOnly ? 'sql-preview-editor' : 'raw-sql-editor',
        value: props.value ?? '',
        readOnly: props.readOnly ?? false,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(event.currentTarget.value),
      }),
  };
});

const COLUMNS: ColumnInfo[] = [
  { name: 'k_timestamp', type: 'TIMESTAMP', isTag: false, isTimeColumn: true, isPrimaryTag: false },
  { name: 'device_id', type: 'VARCHAR', isTag: true, isTimeColumn: false, isPrimaryTag: true },
  { name: 'temperature', type: 'FLOAT8', isTag: false, isTimeColumn: false, isPrimaryTag: false },
];

const BASE_QUERY: KwdbQuery = {
  refId: 'A',
  mode: 'downsampling',
  format: 'time_series',
  interval: '5m',
  metrics: [{ column: '', aggregation: 'avg' }],
};

function makeDatasource(): KwdbDataSource {
  return {
    getTables: jest.fn().mockResolvedValue([{ name: 'sensors', type: 'TIME SERIES TABLE' }]),
    getColumns: jest.fn().mockResolvedValue(COLUMNS),
  } as unknown as KwdbDataSource;
}

function renderEditor(query: KwdbQuery) {
  const onChange = jest.fn();
  const onRunQuery = jest.fn();
  render(<QueryEditor datasource={makeDatasource()} query={query} onChange={onChange} onRunQuery={onRunQuery} />);
  return { onChange, onRunQuery };
}

function renderWithState(initialQuery: KwdbQuery) {
  const datasource = makeDatasource();
  function Harness() {
    const [query, setQuery] = useState(initialQuery);
    return <QueryEditor datasource={datasource} query={query} onChange={setQuery} onRunQuery={jest.fn()} />;
  }
  render(<Harness />);
}

async function switchMode(label: string) {
  const modeInput = screen.getByLabelText('Mode');
  fireEvent.keyDown(modeInput, { key: 'ArrowDown', keyCode: 40 });
  fireEvent.click(await screen.findByText(label));
}

describe('QueryEditor', () => {
  it('renders the downsampling mode with shared builder fields', () => {
    renderEditor({ ...BASE_QUERY });

    expect(screen.getByLabelText('Mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Format')).toBeInTheDocument();
    expect(screen.getByLabelText('Table')).toBeInTheDocument();
    expect(screen.getByLabelText('Time column')).toBeInTheDocument();
    expect(screen.getByLabelText('Interval')).toBeInTheDocument();
    expect(screen.getByLabelText('Tags')).toBeInTheDocument();
    expect(screen.getByLabelText('Metric column 0')).toBeInTheDocument();
    expect(screen.getByTestId('sql-preview-editor')).toBeInTheDocument();
  });

  it('renders the resizable SQL preview handle', () => {
    renderEditor({ ...BASE_QUERY });

    expect(screen.getByTestId('sql-preview-resize-handle')).toBeInTheDocument();
  });

  it('accepts a custom downsampling interval', () => {
    const { onChange } = renderEditor({ ...BASE_QUERY });
    const intervalInput = screen.getByLabelText('Interval');

    fireEvent.change(intervalInput, { target: { value: '90s' } });
    fireEvent.keyDown(intervalInput, { key: 'Enter', keyCode: 13 });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        interval: '90s',
      })
    );
  });

  it('switches to raw SQL mode and renders the SQL editor', async () => {
    renderWithState({ ...BASE_QUERY });
    await switchMode('Raw SQL');
    expect(screen.getByTestId('raw-sql-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('sql-preview-editor')).not.toBeInTheDocument();
  });

  it('switches to gapfill mode and renders the interpolation selector', async () => {
    renderWithState({ ...BASE_QUERY });
    await switchMode('Gapfill');
    expect(screen.getByLabelText('Interpolation mode')).toBeInTheDocument();
  });

  it('switches to latest values mode and renders the latest function selector', async () => {
    renderWithState({ ...BASE_QUERY });
    await switchMode('Latest Values');
    expect(screen.getByLabelText('Latest function')).toBeInTheDocument();
  });

  it('switches to window/event mode and renders the window type selector', async () => {
    renderWithState({ ...BASE_QUERY });
    await switchMode('Window/Event');
    expect(screen.getByLabelText('Window type')).toBeInTheDocument();
    expect(screen.getByLabelText('Window interval')).toBeInTheDocument();
  });

  it('clears window-type-specific fields when the window type changes', async () => {
    const { onChange } = renderEditor({
      ...BASE_QUERY,
      mode: 'window',
      table: 'sensors',
      timeColumn: 'k_timestamp',
      windowType: 'TIME_WINDOW',
      windowInterval: '1h',
      windowSlide: '15m',
      eventStartCond: 'temperature > 100',
      eventEndCond: 'temperature <= 100',
      metrics: [{ column: 'temperature', aggregation: 'avg' }],
    });

    fireEvent.keyDown(screen.getByLabelText('Window type'), { key: 'ArrowDown', keyCode: 40 });
    fireEvent.click(await screen.findByText('COUNT_WINDOW'));

    const updated = onChange.mock.calls[0][0] as KwdbQuery;
    expect(updated).toEqual(
      expect.objectContaining({
        windowType: 'COUNT_WINDOW',
        windowInterval: undefined,
        windowSlide: undefined,
        eventStartCond: undefined,
        eventEndCond: undefined,
      })
    );
    // COUNT_WINDOW falls back to the editor's default row limit of 100, so a
    // statement is generated as soon as the type is selected.
    expect(updated.rawSql).toContain('COUNT_WINDOW(100)');
  });

  it('keeps window fields when the current window type is selected again', async () => {
    const { onChange } = renderEditor({
      ...BASE_QUERY,
      mode: 'window',
      table: 'sensors',
      timeColumn: 'k_timestamp',
      windowType: 'TIME_WINDOW',
      windowInterval: '1h',
      windowSlide: '15m',
      metrics: [{ column: 'temperature', aggregation: 'avg' }],
    });

    fireEvent.keyDown(screen.getByLabelText('Window type'), { key: 'ArrowDown', keyCode: 40 });
    fireEvent.click(await screen.findByRole('option', { name: 'TIME_WINDOW' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears columns from the previous table when the table changes', async () => {
    const { onChange } = renderEditor({
      ...BASE_QUERY,
      table: 'old_table',
      timeColumn: 'old_ts',
      tags: ['old_tag'],
      metrics: [{ column: 'old_metric', aggregation: 'avg' }],
    });

    fireEvent.keyDown(screen.getByLabelText('Table'), { key: 'ArrowDown', keyCode: 40 });
    fireEvent.click(await screen.findByText('sensors (TIME SERIES TABLE)'));

    const updated = onChange.mock.calls[0][0] as KwdbQuery;
    expect(updated).toEqual(
      expect.objectContaining({
        table: 'sensors',
        timeColumn: undefined,
        tags: [],
        metrics: [],
      })
    );
    expect(updated.rawSql).toBe('');
  });

  it('keeps the selected columns when the current table is selected again', async () => {
    const { onChange } = renderEditor({
      ...BASE_QUERY,
      table: 'sensors',
      timeColumn: 'k_timestamp',
      tags: ['device_id'],
      metrics: [{ column: 'temperature', aggregation: 'avg' }],
    });

    fireEvent.keyDown(screen.getByLabelText('Table'), { key: 'ArrowDown', keyCode: 40 });
    fireEvent.click(await screen.findByRole('option', { name: 'sensors (TIME SERIES TABLE)' }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores hand-written raw SQL after a round trip through a builder mode', async () => {
    renderWithState({ ...BASE_QUERY });
    await switchMode('Raw SQL');

    fireEvent.change(screen.getByTestId('raw-sql-editor'), {
      target: { value: 'SELECT "ts", "temperature" FROM "sensors"' },
    });
    expect(screen.getByTestId('raw-sql-editor')).toHaveValue('SELECT "ts", "temperature" FROM "sensors"');

    await switchMode('Downsampling');
    await switchMode('Raw SQL');

    expect(screen.getByTestId('raw-sql-editor')).toHaveValue('SELECT "ts", "temperature" FROM "sensors"');
  });

  it('generates constant interpolation SQL with a numeric value from the gapfill editor', async () => {
    renderWithState({
      ...BASE_QUERY,
      mode: 'gapfill',
      table: 'sensors',
      timeColumn: 'k_timestamp',
      interval: '5m',
      metrics: [{ column: 'temperature', aggregation: 'avg' }],
    });

    fireEvent.keyDown(screen.getByLabelText('Interpolation mode'), { key: 'ArrowDown', keyCode: 40 });
    fireEvent.click(await screen.findByText('constant'));

    const constantInput = screen.getByLabelText('Constant value');
    expect(constantInput).toHaveValue(0);

    fireEvent.change(constantInput, { target: { value: '42' } });

    expect((screen.getByTestId('sql-preview-editor') as HTMLTextAreaElement).value).toContain(
      'interpolate(avg("temperature"), 42)'
    );
  });
});
