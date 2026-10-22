import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import {
  expectQuerySucceeded,
  fieldNames,
  rowCount,
  selectIntervalWhenPreset,
  selectMetric,
  selectTable,
  selectTimeColumn,
  setMode,
  setQueryTimeRange,
  skipIfTableUnavailable,
} from './helpers';

test.describe('visual query builder', () => {
  // Panel editor setup (time range picker + several async dropdowns) exceeds the 30s default
  // timeout on slower Grafana instances; the assertions themselves are fast.
  test.describe.configure({ timeout: 120_000 });

  test('downsampling returns time buckets and an aggregated metric', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await setQueryTimeRange(panelEditPage);

    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);
    await selectIntervalWhenPreset(page);

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(frames.length).toBeGreaterThan(0);
    const frame = frames[0];
    const names = fieldNames(frame);

    expect(names, 'downsampling must return a time field').toContain('time');
    expect(
      names.some((name) => name !== 'time' && name.includes(e2eConfig.metric)),
      `expected an aggregated field for ${e2eConfig.metric}, got ${names.join(', ')}`
    ).toBeTruthy();
    expect(rowCount(frame), 'downsampling query returned no rows for the configured time range').toBeGreaterThan(0);
  });

  test('gapfill with linear interpolation returns filled buckets', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await setQueryTimeRange(panelEditPage);

    await setMode(page, 'Gapfill');
    // KWDB's gapfill/imputation aggregate is expensive: a 30 day range exceeds
    // the default 30s query timeout, so this test uses the shorter configurable
    // range instead of the shared builder range.
    await setQueryTimeRange(panelEditPage, { from: e2eConfig.gapfillFrom, to: e2eConfig.gapfillTo });
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);
    await selectIntervalWhenPreset(page);

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(frames.length).toBeGreaterThan(0);
    const frame = frames[0];
    const names = fieldNames(frame);

    expect(names, 'gapfill must return a time field').toContain('time');
    expect(
      names.some((name) => name !== 'time' && name.includes(e2eConfig.metric)),
      `expected an interpolated field for ${e2eConfig.metric}, got ${names.join(', ')}`
    ).toBeTruthy();
    expect(rowCount(frame), 'gapfill query returned no rows for the configured time range').toBeGreaterThan(0);
  });
});
