import { DataQueryRequest, MetricFindValue } from '@grafana/data';

import type { KwdbDataSource } from './datasource';
import type { KwdbVariableQuery } from './types';
import { KwdbVariableSupport } from './variableSupport';

function makeRequest(targets: unknown[], extra: Partial<DataQueryRequest> = {}): DataQueryRequest {
  return {
    targets,
    range: { from: new Date(0), to: new Date(60_000), raw: { from: 'now-1m', to: 'now' } },
    scopedVars: {},
    ...extra,
  } as unknown as DataQueryRequest;
}

function makeDatasource(results: MetricFindValue[] | Error): KwdbDataSource {
  const metricFindQuery = jest.fn();
  if (results instanceof Error) {
    metricFindQuery.mockRejectedValue(results);
  } else {
    metricFindQuery.mockResolvedValue(results);
  }
  return { metricFindQuery } as unknown as KwdbDataSource;
}

function metricFindQueryMock(datasource: KwdbDataSource): jest.Mock {
  return datasource.metricFindQuery as unknown as jest.Mock;
}

describe('KwdbVariableSupport', () => {
  it('declares the custom variable support type', () => {
    expect(new KwdbVariableSupport(makeDatasource([])).getType()).toBe('custom');
  });

  it('passes the first request target through to metricFindQuery', async () => {
    const query: KwdbVariableQuery = { queryType: 'tagValues', table: 'sensors', column: 'location' };
    const datasource = makeDatasource([{ text: 'Beijing', value: 'Beijing' }]);
    const support = new KwdbVariableSupport(datasource);

    const response = await new Promise<{ data: MetricFindValue[] }>((resolve, reject) => {
      support.query(makeRequest([query])).subscribe({ next: resolve, error: reject });
    });

    expect(metricFindQueryMock(datasource)).toHaveBeenCalledTimes(1);
    expect(metricFindQueryMock(datasource)).toHaveBeenCalledWith(query, expect.anything());
    expect(response.data).toEqual([{ text: 'Beijing', value: 'Beijing' }]);
  });

  it('forwards the time range and scoped variables so cascading variables keep working', async () => {
    const datasource = makeDatasource([]);
    const support = new KwdbVariableSupport(datasource);
    const scopedVars = { schema: { text: 'public', value: 'public' } };

    await new Promise<void>((resolve, reject) => {
      support
        .query(makeRequest([{ queryType: 'tables' }], { scopedVars }))
        .subscribe({ complete: resolve, error: reject });
    });

    const [, options] = metricFindQueryMock(datasource).mock.calls[0];
    expect(options.scopedVars).toBe(scopedVars);
    expect(options.range).toBeDefined();
  });

  it('returns an empty result when the request carries no targets', async () => {
    const datasource = makeDatasource([]);
    const support = new KwdbVariableSupport(datasource);

    const response = await new Promise<{ data: MetricFindValue[] }>((resolve, reject) => {
      support.query(makeRequest([])).subscribe({ next: resolve, error: reject });
    });

    expect(response.data).toEqual([]);
    expect(metricFindQueryMock(datasource)).not.toHaveBeenCalled();
  });

  it('propagates a failing variable query as an observable error', async () => {
    const datasource = makeDatasource(new Error('Unsupported variable query'));
    const support = new KwdbVariableSupport(datasource);

    await expect(
      new Promise<void>((resolve, reject) => {
        support.query(makeRequest([{ queryType: 'tables' }])).subscribe({ complete: resolve, error: reject });
      })
    ).rejects.toThrow('Unsupported variable query');
  });

  it('maps table and column lookups to text/value pairs', async () => {
    const datasource = makeDatasource([
      { text: 'sensors', value: 'sensors' },
      { text: 'ts', value: 'ts' },
    ]);
    const support = new KwdbVariableSupport(datasource);

    const response = await new Promise<{ data: MetricFindValue[] }>((resolve, reject) => {
      support
        .query(makeRequest([{ queryType: 'columns', table: 'sensors' }]))
        .subscribe({ next: resolve, error: reject });
    });

    expect(response.data.map((item) => item.value)).toEqual(['sensors', 'ts']);
  });
});
