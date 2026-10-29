import { expect, test } from '@grafana/plugin-e2e';
import type { PanelEditPage } from '@grafana/plugin-e2e';
import type { Page } from '@playwright/test';

import { e2eConfig } from './config';
import {
  expectQuerySucceeded,
  expectSqlPreviewContains,
  fieldNames,
  pickOption,
  rowCount,
  selectMetric,
  selectTable,
  selectTimeColumn,
  setMode,
  setQueryTimeRange,
  skipIfTableUnavailable,
} from './helpers';

/**
 * Fills one of the free text window fields (interval, slide, conditions, ...).
 *
 * `fill()` replaces the whole value in one input event. The COUNT_WINDOW row limit uses that
 * value verbatim in the SQL, and the resulting re-render races with monaco's asynchronous
 * model update, so the preview keeps the previous (empty) statement. Typing the value with the
 * field cleared first produces the same final state through several smaller updates, which the
 * preview does pick up.
 */
async function fillWindowField(page: Page, label: string, value: string): Promise<void> {
  const input = page.getByRole('textbox', { name: label });
  await expect(input, `the "${label}" input must be rendered for the selected window type`).toBeVisible();
  await input.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(value, { delay: 60 });
}

/**
 * Window/Event queries are window functions, which are far more expensive than the downsampling
 * aggregate: over the default 30 day builder range a sliding or count window exhausts KWDB's
 * memory budget (`group-window-func: memory budget exceeded`). Every window test therefore uses
 * the short configurable range that the gapfill test already relies on.
 */
function useShortQueryRange(panelEditPage: PanelEditPage): Promise<void> {
  return setQueryTimeRange(panelEditPage, { from: e2eConfig.gapfillFrom, to: e2eConfig.gapfillTo });
}

/** Window mode aggregates the metric with the default `avg` aggregation. */
function namesContainMetric(names: string[]): boolean {
  return names.some((name) => name !== 'time' && name.includes(e2eConfig.metric));
}

test.describe('window/event query builder', () => {
  test.describe.configure({ timeout: 120_000 });

  test('time window builds a TIME_WINDOW() query and returns one row per window', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await useShortQueryRange(panelEditPage);

    await setMode(page, 'Window/Event');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    await expectSqlPreviewContains(
      page,
      `TIME_WINDOW("${e2eConfig.timeColumn}", '1h')`,
      'time window mode must aggregate with TIME_WINDOW()'
    );
    await expectSqlPreviewContains(
      page,
      `first("${e2eConfig.timeColumn}") AS "time"`,
      'time window mode must return the first timestamp of the window as "time"'
    );
    await expectSqlPreviewContains(
      page,
      `GROUP BY TIME_WINDOW("${e2eConfig.timeColumn}", '1h')`,
      'the window expression must be part of the GROUP BY clause'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(fieldNames(frames[0]), 'window queries must return a time field').toContain('time');
    expect(
      namesContainMetric(fieldNames(frames[0])),
      `expected an aggregated field for ${e2eConfig.metric}, got ${fieldNames(frames[0]).join(', ')}`
    ).toBeTruthy();
    expect(rowCount(frames[0]), 'the time window query returned no rows').toBeGreaterThan(0);
  });

  test('the window interval and slide fields are written into the SQL', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await useShortQueryRange(panelEditPage);

    await setMode(page, 'Window/Event');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    await fillWindowField(page, 'Window interval', '30m');
    await fillWindowField(page, 'Slide interval', '15m');

    await expectSqlPreviewContains(
      page,
      `TIME_WINDOW("${e2eConfig.timeColumn}", '30m', '15m')`,
      'the window interval and slide must be used verbatim in TIME_WINDOW()'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(fieldNames(frames[0]), 'the sliding window query must return a time field').toContain('time');
    expect(rowCount(frames[0]), 'the sliding window query returned no rows').toBeGreaterThan(0);
  });

  test('count window builds a COUNT_WINDOW() query over a row limit', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await useShortQueryRange(panelEditPage);

    await setMode(page, 'Window/Event');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    // Switching the window type clears the fields of the previous type, so the row limit has to
    // be entered after the change.
    await pickOption(page, 'Window type', 'COUNT_WINDOW');
    await fillWindowField(page, 'Row limit', '100');
    await fillWindowField(page, 'Slide rows', '10');

    await expectSqlPreviewContains(
      page,
      'COUNT_WINDOW(100, 10)',
      'count window mode must aggregate with COUNT_WINDOW()'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(fieldNames(frames[0]), 'count window queries must return a time field').toContain('time');
    expect(rowCount(frames[0]), 'the count window query returned no rows').toBeGreaterThan(0);
  });

  test('session window builds a SESSION_WINDOW() query from the threshold', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await useShortQueryRange(panelEditPage);

    await setMode(page, 'Window/Event');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    await pickOption(page, 'Window type', 'SESSION_WINDOW');
    await fillWindowField(page, 'Session threshold', '1h');

    await expectSqlPreviewContains(
      page,
      `SESSION_WINDOW("${e2eConfig.timeColumn}", '1h')`,
      'session window mode must aggregate with SESSION_WINDOW()'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(fieldNames(frames[0]), 'session window queries must return a time field').toContain('time');
    expect(rowCount(frames[0]), 'the session window query returned no rows').toBeGreaterThan(0);
  });

  test('event window builds an EVENT_WINDOW() query from both conditions', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await useShortQueryRange(panelEditPage);

    await setMode(page, 'Window/Event');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    await pickOption(page, 'Window type', 'EVENT_WINDOW');
    await fillWindowField(page, 'Event start condition', `${e2eConfig.metric} > 30`);
    await fillWindowField(page, 'Event end condition', `${e2eConfig.metric} <= 30`);

    await expectSqlPreviewContains(
      page,
      `EVENT_WINDOW(${e2eConfig.metric} > 30, ${e2eConfig.metric} <= 30)`,
      'event window mode must inject both conditions into EVENT_WINDOW()'
    );

    // The number of events depends on how often the metric crosses the threshold, so the query is
    // only asserted to be accepted by KWDB and to return the window's first timestamp.
    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(fieldNames(frames[0]), 'event window queries must return a time field').toContain('time');
  });

  test('state window builds a STATE_WINDOW() query from the expression', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await useShortQueryRange(panelEditPage);

    await setMode(page, 'Window/Event');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    await pickOption(page, 'Window type', 'STATE_WINDOW');
    await fillWindowField(page, 'State expression', `CASE WHEN ${e2eConfig.metric} >= 0 THEN 1 ELSE 0 END`);

    await expectSqlPreviewContains(
      page,
      `STATE_WINDOW(CASE WHEN ${e2eConfig.metric} >= 0 THEN 1 ELSE 0 END)`,
      'state window mode must inject the expression into STATE_WINDOW()'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(fieldNames(frames[0]), 'state window queries must return a time field').toContain('time');
    expect(rowCount(frames[0]), 'the state window query returned no rows').toBeGreaterThan(0);
  });
});
