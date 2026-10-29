import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { VariableQueryEditor } from '../src/components/VariableQueryEditor';
import type { KwdbDataSource } from '../src/datasource';
import type { ColumnInfo, TableInfo } from '../src/types';

// The scaffold's react-inlinesvg mock renders the icon without forwarding any
// props, which drops the aria-label and onMouseDown Grafana's Select puts on its
// clear indicator. Forward them so the clear button is reachable in jsdom.
jest.mock('react-inlinesvg', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ src, innerRef, loader, ...rest }: Record<string, unknown>) =>
      ReactModule.createElement('svg', { 'data-testid': 'inline-svg', ...rest }),
  };
});

const TABLES: TableInfo[] = [
  { name: 'sensors', type: 'TIME SERIES TABLE' },
  { name: 'devices', type: 'TIME SERIES TABLE' },
];

const COLUMNS: ColumnInfo[] = [
  { name: 'device_id', type: 'VARCHAR', isTag: true, isTimeColumn: false, isPrimaryTag: true },
  { name: 'location', type: 'VARCHAR', isTag: true, isTimeColumn: false, isPrimaryTag: false },
];

function makeDatasource(): KwdbDataSource {
  return {
    getTables: jest.fn().mockResolvedValue(TABLES),
    getColumns: jest.fn().mockResolvedValue(COLUMNS),
  } as unknown as KwdbDataSource;
}

function renderEditor(query: string | null | undefined) {
  const onChange = jest.fn();
  const datasource = makeDatasource();
  render(<VariableQueryEditor query={query} datasource={datasource} onChange={onChange} />);
  return { onChange, datasource };
}

async function openAndPick(label: string, option: string | RegExp) {
  fireEvent.keyDown(screen.getByLabelText(label), { key: 'ArrowDown', keyCode: 40 });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

describe('VariableQueryEditor', () => {
  it('reports the table as soon as it is selected, before a tag column exists', async () => {
    const { onChange } = renderEditor('');

    await openAndPick('Variable table', /sensors/);

    // This used to throw from the React event handler (buildVariableQueryString
    // rejects an incomplete query), so onChange was never called and the change
    // never reached the Grafana variable model.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ queryType: 'tagValues', table: 'sensors' });
    // There is no renderable definition for an incomplete query; that is not an
    // error, so the definition is empty instead of throwing.
    expect(onChange.mock.calls[0][1]).toBe('');
  });

  it('switches to the Columns query type without throwing', async () => {
    const { onChange } = renderEditor('');

    await openAndPick('Variable query type', 'Columns');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ queryType: 'columns' });
    expect(onChange.mock.calls[0][1]).toBe('');
  });

  it('clears the table without throwing and reports the incomplete query', async () => {
    const { onChange } = renderEditor('');

    await openAndPick('Variable table', /sensors/);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Grafana's Select passes null on clear; the handler must not dereference it.
    fireEvent.mouseDown(screen.getByLabelText('Clear value'));

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toEqual({ queryType: 'tagValues' });
    expect(onChange.mock.calls[1][1]).toBe('');
  });

  it('clears the tag column without throwing', async () => {
    const { onChange } = renderEditor('');

    await openAndPick('Variable table', /sensors/);
    await openAndPick('Variable tag column', 'device_id');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0]).toEqual({
      queryType: 'tagValues',
      table: 'sensors',
      column: 'device_id',
    });

    const clearButtons = screen.getAllByLabelText('Clear value');
    fireEvent.mouseDown(clearButtons[1]);

    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange.mock.calls[2][0]).toEqual({ queryType: 'tagValues', table: 'sensors' });
    expect(onChange.mock.calls[2][1]).toBe('');
  });

  it('reports the complete query and its definition once it is renderable', async () => {
    const { onChange } = renderEditor('');

    await openAndPick('Variable table', /sensors/);
    await openAndPick('Variable tag column', 'device_id');

    expect(onChange).toHaveBeenLastCalledWith(
      { queryType: 'tagValues', table: 'sensors', column: 'device_id' },
      'tag_values(sensors, device_id)'
    );
  });

  it('starts from the parsed form of a legacy string query', async () => {
    const { onChange } = renderEditor('tag_values(sensors, device_id)');

    // Parsing happens on mount; rendering alone must not rewrite the model.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('sensors')).toBeInTheDocument();
    expect(screen.getByText('device_id')).toBeInTheDocument();

    // Switching type drops the columns the parsed query carried.
    await openAndPick('Variable query type', 'Tables');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual({ queryType: 'tables' });
    expect(onChange.mock.calls[0][1]).toBe('tables()');
  });
});
