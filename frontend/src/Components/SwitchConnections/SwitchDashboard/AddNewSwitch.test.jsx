import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import AddNewSwitch from './AddNewSwitch';
import { switchInput } from '../../Helpers/InputHelper';

vi.mock('../../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ switchesOnline: { switches_online: [] }, getSwitches: vi.fn(), getHistorySwitches: vi.fn(), setCurrentSwitchID: vi.fn() }) }));
vi.mock('../../../Contexts/SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: vi.fn() }) }));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); axios.post.mockResolvedValue({ data: {} }); });

describe('external switch register adapter', () => {
  it('shows internal register support enabled without a second limited adapter', () => {
    const config = { name: 's1', address: '127.0.0.1:50051', device_id: 0, register_adapter_enabled: false,
      register_thrift_host: '127.0.0.1', register_thrift_port: 9090 };
    render(switchInput(config, { switches_online: [{ name: 's1', dev_id: 0, grpc_port: 50051, thrift_port: 9090 }] }, vi.fn(), vi.fn()));
    expect(screen.getByRole('checkbox', { name: 'Built-in register support enabled' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Built-in register support enabled' })).toBeDisabled();
    expect(screen.getByText(/up to 64 bits/)).toBeVisible();
    expect(config.register_adapter_enabled).toBe(false);
  });
  it('defaults off and never infers a Thrift host', () => {
    render(<AddNewSwitch open setOpen={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Enable BMv2 register adapter' })).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: 'BMv2 Thrift host' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'BMv2 Thrift host' })).not.toBeRequired();
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('requires explicit opt-in and sends the chosen host and port', async () => {
    const user = userEvent.setup();
    render(<AddNewSwitch open setOpen={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Switch Name' }), 'remote');
    await user.type(screen.getByRole('textbox', { name: 'Switch Address:Switch Port' }), '192.0.2.10:50051');
    await user.type(screen.getByRole('textbox', { name: 'Switch Device ID' }), '0');
    await user.click(screen.getByRole('checkbox', { name: 'Enable BMv2 register adapter' }));
    const host = screen.getByRole('textbox', { name: 'BMv2 Thrift host' });
    expect(host).toBeRequired();
    expect(host).toHaveValue('');
    await user.type(host, '192.0.2.10');
    const port = screen.getByRole('textbox', { name: 'BMv2 Thrift port' });
    await user.clear(port); await user.type(port, '9091');
    await user.click(screen.getByRole('button', { name: 'Add Switch', exact: true }));
    const config = JSON.parse(axios.post.mock.calls[0][1].switch_config);
    expect(config).toMatchObject({ device_id: 0, register_adapter_enabled: true, register_thrift_host: '192.0.2.10', register_thrift_port: 9091 });
  });
});
