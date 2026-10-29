import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DataSourceSettings } from '@grafana/data';

import { ConfigEditor } from '../src/components/ConfigEditor';
import type { KwdbDataSourceOptions, KwdbSecureJsonData } from '../src/types';

function makeOptions(overrides: Partial<DataSourceSettings<KwdbDataSourceOptions, KwdbSecureJsonData>> = {}) {
  return {
    type: 'kwdb-datasource',
    uid: 'kwdb',
    name: 'KWDB TSDB',
    access: 'proxy',
    jsonData: {},
    secureJsonFields: {},
    secureJsonData: {},
    ...overrides,
  } as DataSourceSettings<KwdbDataSourceOptions, KwdbSecureJsonData>;
}

function renderConfig(overrides: Partial<DataSourceSettings<KwdbDataSourceOptions, KwdbSecureJsonData>> = {}) {
  const onOptionsChange = jest.fn();
  const options = makeOptions(overrides);
  render(<ConfigEditor options={options} onOptionsChange={onOptionsChange} />);
  return { onOptionsChange, options };
}

describe('ConfigEditor', () => {
  it('renders all connection fields', () => {
    renderConfig();

    expect(screen.getByLabelText('Host')).toBeInTheDocument();
    expect(screen.getByLabelText('Port')).toBeInTheDocument();
    expect(screen.getByLabelText('Database')).toBeInTheDocument();
    expect(screen.getByLabelText('User')).toBeInTheDocument();
    expect(screen.getByLabelText('SSL Mode')).toBeInTheDocument();
    expect(screen.getByLabelText('SSL Root Cert')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Query timeout (s)')).toBeInTheDocument();
    expect(screen.getByLabelText('Max rows')).toBeInTheDocument();
  });

  it('persists the query timeout and row cap as numbers', () => {
    const { onOptionsChange } = renderConfig();

    fireEvent.change(screen.getByLabelText('Query timeout (s)'), { target: { value: '45' } });
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ queryTimeout: 45 }) })
    );

    fireEvent.change(screen.getByLabelText('Max rows'), { target: { value: '5000' } });
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ maxRows: 5000 }) })
    );
  });

  it('updates jsonData when host, port, database and user change', () => {
    const { onOptionsChange } = renderConfig();

    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'localhost' } });
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ host: 'localhost' }) })
    );

    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5432' } });
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ port: 5432 }) })
    );

    fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'demo_ts' } });
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ database: 'demo_ts' }) })
    );

    fireEvent.change(screen.getByLabelText('User'), { target: { value: 'root' } });
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ user: 'root' }) })
    );
  });

  it('updates secureJsonData when the password changes', () => {
    const { onOptionsChange } = renderConfig();

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 's3cret' } });
    expect(onOptionsChange).toHaveBeenCalledWith(
      expect.objectContaining({ secureJsonData: expect.objectContaining({ password: 's3cret' }) })
    );
  });

  it('updates sslRootCert through the input', () => {
    const { onOptionsChange } = renderConfig();

    fireEvent.change(screen.getByLabelText('SSL Root Cert'), { target: { value: '/etc/certs/ca.pem' } });
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ sslRootCert: '/etc/certs/ca.pem' }) })
    );
  });

  it('updates sslMode through the select', async () => {
    const { onOptionsChange } = renderConfig();

    const sslModeInput = screen.getByLabelText('SSL Mode');
    fireEvent.keyDown(sslModeInput, { key: 'ArrowDown', keyCode: 40 });
    fireEvent.click(await screen.findByText('require'));
    expect(onOptionsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ jsonData: expect.objectContaining({ sslMode: 'require' }) })
    );
  });

  it('resets the configured password', () => {
    const { onOptionsChange } = renderConfig({
      secureJsonFields: { password: true },
      secureJsonData: { password: 'old' },
    });

    fireEvent.click(screen.getByText('Reset'));
    expect(onOptionsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        secureJsonFields: expect.objectContaining({ password: false }),
        secureJsonData: expect.objectContaining({ password: '' }),
      })
    );
  });
});
