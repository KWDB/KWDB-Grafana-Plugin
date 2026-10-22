import { expect, test } from '@grafana/plugin-e2e';

test('provisioned KWDB datasource passes health check', async ({ readProvisionedDataSource, page }) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });

  const response = await page.request.get(`/api/datasources/uid/${ds.uid}/health`);
  expect(response.ok()).toBeTruthy();

  const body = (await response.json()) as { status?: string; message?: string };
  expect(body.status).toBe('OK');
  expect(body.message ?? '').toContain('working');
});
