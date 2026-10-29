import { CustomVariableSupport, DataQueryRequest, DataQueryResponse, VariableSupportType } from '@grafana/data';
import { from, map, Observable, of } from 'rxjs';

import { VariableQueryEditor } from './components/VariableQueryEditor';
import type { KwdbDataSource } from './datasource';
import type { KwdbDataSourceOptions, KwdbQuery, KwdbVariableQuery } from './types';

/**
 * Registers the structured variable query editor and executes template
 * variable queries.
 *
 * This replaces the deprecated `DataSourcePlugin.setVariableQueryEditor`
 * registration: Grafana now discovers the editor and the query implementation
 * through the `variables` property of the data source instance.
 *
 * The generic parameter is `any` because `KwdbVariableQuery` deliberately does
 * not extend `DataQuery`: a template variable query has no `refId`, and Grafana
 * only ever reads `queryType`/`table`/`column` from it. The concrete model is
 * re-asserted on the request target below.
 */
export class KwdbVariableSupport extends CustomVariableSupport<KwdbDataSource, any, KwdbQuery, KwdbDataSourceOptions> {
  constructor(private readonly datasource: KwdbDataSource) {
    super();
  }

  editor = VariableQueryEditor;

  getType(): VariableSupportType {
    return VariableSupportType.Custom;
  }

  /**
   * Seeds a brand-new query variable with a valid, cheap query (`tables()`)
   * instead of leaving it empty.
   *
   * The base class types the return value as `Partial<TQuery>` (the *panel*
   * query), because Grafana shares one helper between both paths; on the
   * variable path the value is consumed as the variable query model.
   */
  getDefaultQuery(): Partial<KwdbQuery> & KwdbVariableQuery {
    return { queryType: 'tables' };
  }

  query(request: DataQueryRequest<any>): Observable<DataQueryResponse> {
    const target = request.targets?.[0];
    if (target === undefined || target === null || target === '') {
      // Grafana always sends at least one target; an empty one means the
      // variable has no query yet, which is not an error.
      return of({ data: [] });
    }

    if (typeof target !== 'string' && typeof (target as KwdbVariableQuery).queryType !== 'string') {
      // Grafana replaces an empty variable query with the data source's *panel*
      // default query before it reaches this method (see runRequest's
      // callQueryMethod). That object is not a variable query, so do not send it
      // through metricFindQuery and surface "Unsupported variable query" for a
      // variable the user has not configured yet.
      return of({ data: [] });
    }

    const { range, scopedVars } = request;

    // Grafana accepts either a frame or a MetricFindValue array here; returning
    // the MetricFindValue array directly is what the legacy path did.
    return from(this.datasource.metricFindQuery(target, { scopedVars, range })).pipe(map((data) => ({ data })));
  }
}
