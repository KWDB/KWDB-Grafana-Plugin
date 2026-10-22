import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import {
  expectQuerySucceeded,
  fieldNames,
  rowCount,
  setFormat,
  setMode,
  setRawSql,
  skipIfTableUnavailable,
} from './helpers';

test('raw SQL table format returns the selected columns as rows', async ({
  readProvisionedDataSource,
  page,
  panelEditPage,
}) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await skipIfTableUnavailable(page, ds.uid);

  await panelEditPage.datasource.set(ds.name);
  await panelEditPage.setVisualization('Table');

  await setMode(page, 'Raw SQL');
  await setFormat(page, 'Table');

  const sql = `SELECT ${e2eConfig.columns.join(', ')} FROM ${e2eConfig.table} LIMIT 3`;
  await setRawSql(page, sql);

  const response = await panelEditPage.refreshPanel();
  const frames = await expectQuerySucceeded(response);

  expect(frames).toHaveLength(1);
  const frame = frames[0];

  const names = fieldNames(frame);
  for (const column of e2eConfig.columns) {
    expect(names, `frame is missing the selected column ${column}`).toContain(column);
  }

  const rows = rowCount(frame);
  expect(rows, 'expected raw SQL to return at least one row').toBeGreaterThan(0);
  expect(rows, 'LIMIT 3 should return at most three rows').toBeLessThanOrEqual(3);

  // UI level check: the requested columns are actually rendered by the table panel.
  await expect(panelEditPage.panel.fieldNames).toContainText(e2eConfig.columns);
});
