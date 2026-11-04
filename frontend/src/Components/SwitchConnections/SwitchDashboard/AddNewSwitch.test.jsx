import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import AddNewSwitch from './AddNewSwitch';
import EditSwitch from './EditSwitch';
import { switchInput } from '../../Helpers/InputHelper';

const connections = vi.hoisted(() => ({ switches: [], select: vi.fn() }));
vi.mock('../../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ switches: connections.switches, switchesOnline: { switches_online: [] }, getSwitches: vi.fn(), getHistorySwitches: vi.fn(), setCurrentSwitchID: connections.select }) }));
vi.mock('../../../Contexts/SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: vi.fn() }) }));
vi.mock('axios', () => ({ default: { post: vi.fn(), patch: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); connections.switches = []; axios.post.mockResolvedValue({ data: {} }); axios.patch.mockResolvedValue({ data: {} }); });

describe('new connection IDs', () => {
  it.each([[[], 0], [[0, 1], 2], [[0, 2], 1]])('suggests an unused local ID for active IDs %j', (ids, expected) => {
    connections.switches = ids.map(device_id => ({ device_id }));
    render(<AddNewSwitch open setOpen={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: 'Switch Device ID' })).toHaveValue(String(expected));
  });

  it('updates the suggestion as connections arrive and preserves an explicit choice until cancelled', () => {
    const setOpen = vi.fn();
    const view = render(<AddNewSwitch open setOpen={setOpen} />);
    connections.switches = [{ device_id: 0 }, { device_id: 1 }];
    view.rerender(<AddNewSwitch open setOpen={setOpen} />);
    const field = screen.getByRole('textbox', { name: 'Switch Device ID' });
    expect(field).toHaveValue('2');
    fireEvent.change(field, { target: { value: '9' } });
    connections.switches = [...connections.switches, { device_id: 2 }];
    view.rerender(<AddNewSwitch open setOpen={setOpen} />);
    expect(field).toHaveValue('9');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    view.rerender(<AddNewSwitch open={false} setOpen={setOpen} />);
    view.rerender(<AddNewSwitch open setOpen={setOpen} />);
    expect(screen.getByRole('textbox', { name: 'Switch Device ID' })).toHaveValue('3');
  });

  it('submits and selects the suggested ID without requiring an edit', async () => {
    connections.switches = [{ device_id: 0 }, { device_id: 1 }];
    const user = userEvent.setup();
    render(<AddNewSwitch open setOpen={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: 'Switch Name' }), 'remote');
    await user.type(screen.getByRole('textbox', { name: 'Switch Address:Switch Port' }), '192.0.2.10:50051');
    await user.click(screen.getByRole('button', { name: 'Add Switch', exact: true }));
    expect(JSON.parse(axios.post.mock.calls[0][1].switch_config).device_id).toBe(2);
    expect(connections.select).toHaveBeenCalledWith(2);
  });
});

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
  it('configures an external model without carrying incompatible management settings', async () => {
    const user = userEvent.setup();
    render(<AddNewSwitch open setOpen={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Switch target' }));
    await user.click(screen.getByRole('option', { name: 'Tofino' }));
    expect(screen.queryByRole('checkbox', { name: 'Enable BMv2 register adapter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'BMv2 Thrift host' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Switch Name' }), 'model');
    await user.type(screen.getByRole('textbox', { name: 'Switch Address:Switch Port' }), '192.0.2.10:51051');
    await user.type(screen.getByRole('textbox', { name: 'Switch Device ID' }), '7');
    await user.click(screen.getByRole('button', { name: 'Add Switch', exact: true }));
    expect(JSON.parse(axios.post.mock.calls[0][1].switch_config)).toMatchObject({ target: 'tofino', device_id: 7, target_options: { runtime_device_id: 0, pipe_id: 0, client_id: 0 }, register_adapter_enabled: false, register_thrift_host: null, register_thrift_port: null });
  });
  it('updates a saved external connection target and clears incompatible endpoint fields', async () => {
    const user = userEvent.setup();
    render(<EditSwitch open setOpen={vi.fn()} id={12} editConfig={{ name: 'remote', address: '192.0.2.1:51051', device_id: 7, register_adapter_enabled: true, register_thrift_host: '192.0.2.1', register_thrift_port: 9090 }} />);
    await user.click(screen.getByRole('combobox', { name: 'Switch target' }));
    await user.click(screen.getByRole('option', { name: 'Tofino' }));
    expect(screen.queryByRole('textbox', { name: 'BMv2 Thrift port' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit Edit' }));
    expect(JSON.parse(axios.patch.mock.calls[0][1].switch_config)).toMatchObject({ target: 'tofino', target_options: { runtime_device_id: 0, pipe_id: 0 }, register_adapter_enabled: false, register_thrift_host: null, register_thrift_port: null });
  });
  it('adds an observer connection with a boolean read-only option', async () => {
    const user = userEvent.setup();
    render(<AddNewSwitch open setOpen={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Switch target' }));
    await user.click(screen.getByRole('option', { name: 'Tofino', exact: true }));
    await user.type(screen.getByRole('textbox', { name: 'Switch Name' }), 'observer');
    await user.type(screen.getByRole('textbox', { name: 'Switch Address:Switch Port' }), '192.0.2.10:51051');
    await user.type(screen.getByRole('textbox', { name: 'Switch Device ID' }), '7');
    await user.click(screen.getByRole('checkbox', { name: 'Read-only connection' }));
    await user.click(screen.getByRole('button', { name: 'Add Switch', exact: true }));
    expect(JSON.parse(axios.post.mock.calls[0][1].switch_config).target_options.read_only).toBe(true);
  });
  it('preserves observer mode while editing scope and explicitly switches it off', async () => {
    const user = userEvent.setup();
    const props = { open: true, setOpen: vi.fn(), id: 12, editConfig: { name: 'observer', target: 'tofino', address: '192.0.2.1:51051', device_id: 7, target_options: { read_only: true, pipe_id: 0, client_id: 42 } } };
    render(<EditSwitch {...props} />);
    expect(screen.getByRole('checkbox', { name: 'Read-only connection' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Advanced connection' }));
    const client = screen.getByRole('spinbutton', { name: 'Client ID' });
    await user.clear(client); await user.type(client, '43');
    await user.click(screen.getByRole('button', { name: 'Submit Edit' }));
    expect(JSON.parse(axios.patch.mock.calls[0][1].switch_config).target_options).toMatchObject({ read_only: true, client_id: 43 });
    await user.click(screen.getByRole('checkbox', { name: 'Read-only connection' }));
    await user.click(screen.getByRole('button', { name: 'Submit Edit' }));
    expect(JSON.parse(axios.patch.mock.calls[1][1].switch_config).target_options.read_only).toBe(false);
  });
  it('preserves an external connection scope and edits its explicit client selection', async () => {
    const user = userEvent.setup();
    render(<EditSwitch open setOpen={vi.fn()} id={12} editConfig={{ name: 'external', target: 'tofino', address: '192.0.2.1:51051', device_id: 7, target_options: { runtime_device_id: 3, pipe_id: 5, client_id: 7, program_name: 'routing' } }} />);
    expect(screen.queryByRole('spinbutton', { name: 'Pipeline ID' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Advanced connection' }));
    expect(screen.getByRole('spinbutton', { name: 'Runtime device ID' })).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Pipeline ID' })).toHaveValue(5);
    const client = screen.getByRole('spinbutton', { name: 'Client ID' });
    await user.clear(client); await user.type(client, '42');
    await user.click(screen.getByRole('button', { name: 'Submit Edit' }));
    expect(JSON.parse(axios.patch.mock.calls[0][1].switch_config).target_options).toEqual({ runtime_device_id: 3, pipe_id: 5, client_id: 42, program_name: 'routing' });
  });

  it.each([['Runtime device ID', '-1'], ['Pipeline ID', '65535'], ['Client ID', '4294967296'], ['Client ID', '1.5']])('rejects an invalid %s connection scope before HTTP (%s)', async (label, value) => {
    const user = userEvent.setup();
    const view = render(<EditSwitch open setOpen={vi.fn()} id={12} editConfig={{ name: 'external', target: 'tofino', address: '192.0.2.1:51051', device_id: 7, target_options: {} }} />);
    await user.click(screen.getByRole('button', { name: 'Advanced connection' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: label }), { target: { value } });
    fireEvent.submit(view.container.querySelector('form') || document.querySelector('form'));
    expect(axios.patch).not.toHaveBeenCalled();
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
