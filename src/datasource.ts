import { CoreApp, DataSourceInstanceSettings, MetricFindValue } from '@grafana/data';
import { DataSourceWithBackend } from '@grafana/runtime';

import { ColumnInfo, DEFAULT_QUERY, KwdbDataSourceOptions, KwdbQuery, TableInfo } from './types';
import { parseVariableQuery } from './variableQuery';
import { KwdbVariableSupport } from './variableSupport';

export class KwdbDataSource extends DataSourceWithBackend<KwdbQuery, KwdbDataSourceOptions> {
  constructor(instanceSettings: DataSourceInstanceSettings<KwdbDataSourceOptions>) {
    super(instanceSettings);
    this.variables = new KwdbVariableSupport(this);
  }

  getTables(): Promise<TableInfo[]> {
    return this.getResource('/tables');
  }

  getColumns(table: string): Promise<ColumnInfo[]> {
    return this.getResource(`/columns?table=${encodeURIComponent(table)}`);
  }

  // Named fetchTagValues to avoid clashing with the DataSourceApi.getTagValues(options) API.
  fetchTagValues(table: string, column: string): Promise<string[]> {
    return this.getResource(`/tag-values?table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}`);
  }

  getDefaultQuery(_: CoreApp): Partial<KwdbQuery> {
    return { ...DEFAULT_QUERY };
  }

  // Supports dashboard/template variables. Accepts either a structured KwdbVariableQuery
  // (produced by VariableQueryEditor) or a raw query string such as
  // `tag_values(table, column)`, `tables()` or `columns(table)`.
  async metricFindQuery(query: any, _options?: any): Promise<MetricFindValue[]> {
    const parsed = parseVariableQuery(query);
    switch (parsed.queryType) {
      case 'tables': {
        const tables = await this.getTables();
        return (tables ?? []).map((table) => ({ text: table.name, value: table.name }));
      }
      case 'columns': {
        const columns = await this.getColumns(parsed.table ?? '');
        return (columns ?? []).map((column) => ({ text: column.name, value: column.name }));
      }
      case 'tagValues': {
        const values = await this.fetchTagValues(parsed.table ?? '', parsed.column ?? '');
        return (values ?? []).map((value) => ({ text: value, value }));
      }
      default:
        throw new Error(`Unsupported variable query type: ${JSON.stringify(parsed)}`);
    }
  }

  annotations = {};

  filterQuery(query: KwdbQuery): boolean {
    if (query.mode === 'raw') {
      return Boolean(query.rawSql?.trim());
    }
    return Boolean(query.table);
  }
}
