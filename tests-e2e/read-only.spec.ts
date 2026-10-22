import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import { expectQueryRejected, setMode, setRawSql } from './helpers';

// Grafana returns HTTP 200 for a query request even when the individual query fails, so the
// assertions inspect the /api/ds/query body instead of relying on response.ok().
const rejectionCases = [
  {
    name: 'a DELETE statement',
    sql: `DELETE FROM ${e2eConfig.table}`,
  },
  {
    name: 'a multi-statement query',
    sql: `SELECT 1; DROP TABLE ${e2eConfig.table}`,
  },
  {
    name: 'a SELECT INTO statement',
    sql: `SELECT * INTO ${e2eConfig.tableShortName}_copy FROM ${e2eConfig.table}`,
  },
];

for (const rejectionCase of rejectionCases) {
  test(`raw SQL rejects ${rejectionCase.name}`, async ({ readProvisionedDataSource, page, panelEditPage }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });

    await panelEditPage.datasource.set(ds.name);
    await setMode(page, 'Raw SQL');
    await setRawSql(page, rejectionCase.sql);

    const response = await panelEditPage.refreshPanel();
    const result = await expectQueryRejected(response);

    expect(result.error ?? '').toMatch(/read-only|not allowed/i);
  });
}
