import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import {
  fieldNames,
  readQueryResult,
  selectMetric,
  selectTable,
  selectTimeColumn,
  setFormat,
  setMode,
  setRawSql,
  skipIfTableUnavailable,
} from './helpers';

// `src/plugin.json` declares `annotations: true`, so the data source is expected to serve
// Grafana's standard annotation queries: dashboard settings offer it in the annotation query data
// source picker and the plugin's own query editor is rendered inside the annotation editor.
// These tests drive that flow instead of provisioning a second annotation data source, because
// Grafana's built-in annotation support is exactly what a plugin review asks about.
test.describe('annotations', () => {
  test.describe.configure({ timeout: 120_000 });

  test('the KWDB data source is offered as an annotation query source', async ({
    annotationEditPage,
    readProvisionedDataSource,
    page,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    // A new annotation query is bound to the default data source, and the provisioned KWDB data
    // source is the default one. Grafana only binds the default data source when the plugin
    // declares annotation support, so this asserts `annotations: true` is honoured.
    const dataSourceInput = page.getByTestId('Select a data source');
    await expect(dataSourceInput, 'the annotation query must be bound to the KWDB data source').toHaveValue(ds.name);

    // Grafana renders this alert when the selected data source does not support annotations.
    await expect(
      page.getByText('No annotation support for this data source'),
      'Grafana reported that the KWDB data source does not support annotations'
    ).toHaveCount(0);

    // The standard annotation editor renders the data source's own query editor.
    await expect(
      page.getByRole('combobox', { name: 'Mode' }),
      'the annotation editor must render the KWDB query editor'
    ).toBeVisible();
  });

  test('an annotation query returns events for a time/text statement', async ({
    annotationEditPage,
    readProvisionedDataSource,
    page,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await setMode(page, 'Raw SQL');
    // Annotation queries return event rows (time/text), which are not a time series, so the
    // query has to use the table format; the statement below is the shape Grafana's annotation
    // support documents (a time field plus a text field).
    await setFormat(page, 'Table');
    await setRawSql(
      page,
      `SELECT ${e2eConfig.timeColumn} AS time, 'kwdb annotation' AS text FROM ${e2eConfig.table} LIMIT 5`
    );

    const response = await annotationEditPage.runQuery();
    const result = await readQueryResult(response);
    expect(result.error, `annotation query returned an error: ${result.error ?? ''}`).toBeUndefined();

    const frames = result.frames ?? [];
    expect(frames.length, 'the annotation query returned no frames').toBeGreaterThan(0);
    const names = fieldNames(frames[0]);
    expect(names, 'annotation queries must return a time field').toContain('time');
    expect(names, 'annotation queries must return a text field').toContain('text');
    expect(frames[0].data?.values?.[1]?.length ?? 0, 'the annotation query returned no events').toBeGreaterThan(0);

    // The annotation editor converts the frame into events and reports the outcome.
    const resultAlert = page.getByTestId('annotations-query-result-container');
    await expect(resultAlert, 'the annotation editor must report the query result').toBeVisible();
    await expect(resultAlert, 'the annotation editor did not report the returned events').toContainText(/events/);
  });

  test('a builder query used as an annotation query runs without plugin errors', async ({
    annotationEditPage,
    readProvisionedDataSource,
    page,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    // The same builder query a Stat/Gauge panel would use, executed through the annotation
    // pipeline: the latest values mode returns the newest value of the metric.
    await setMode(page, 'Latest Values');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    const response = await annotationEditPage.runQuery();
    const result = await readQueryResult(response);
    expect(result.error, `annotation query returned an error: ${result.error ?? ''}`).toBeUndefined();
    expect([200, 'finished'], `unexpected annotation query status ${String(result.status)}`).toContain(result.status);

    // The latest values frame carries no text column, so Grafana reports the explicit
    // "No events found" outcome rather than an error. Both outcomes are acceptable here; a
    // plugin error is not.
    const resultAlert = page.getByTestId('annotations-query-result-container');
    await expect(resultAlert, 'the annotation editor must report the query result').toBeVisible();
    await expect(resultAlert, 'the annotation editor reported neither events nor an empty result').toContainText(
      /events|No events found/
    );
  });
});
