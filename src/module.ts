import { DataSourcePlugin } from '@grafana/data';

import { ConfigEditor } from './components/ConfigEditor';
import { QueryEditor } from './components/QueryEditor';
import { KwdbDataSource } from './datasource';
import { KwdbDataSourceOptions, KwdbQuery, KwdbSecureJsonData } from './types';

// The template variable editor and the variable query implementation are
// registered through KwdbDataSource.variables (see src/variableSupport.ts);
// DataSourcePlugin.setVariableQueryEditor is deprecated and no longer used.
export const plugin = new DataSourcePlugin<KwdbDataSource, KwdbQuery, KwdbDataSourceOptions, KwdbSecureJsonData>(
  KwdbDataSource
)
  .setConfigEditor(ConfigEditor)
  .setQueryEditor(QueryEditor);
