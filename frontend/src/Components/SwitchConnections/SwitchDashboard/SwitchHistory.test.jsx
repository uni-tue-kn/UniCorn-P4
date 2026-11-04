import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import SwitchHistory from './SwitchHistory';

const known = vi.hoisted(() => ({ switches: [] }));
vi.mock('../../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ historySwitches: known.switches, switchesOnline: { switches_online: [] }, getSwitches: vi.fn(), getHistorySwitches: vi.fn(), setCurrentSwitchID: vi.fn() }) }));
vi.mock('../../../Contexts/SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: vi.fn() }) }));
vi.mock('axios', () => ({ default: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); axios.patch.mockResolvedValue({ data: {} }); });

describe('editing a known switch', () => {
  it('keeps the saved Tofino target and connection options', async () => {
    const options = { runtime_device_id: 3, pipe_id: 0, client_id: 7, read_only: true };
    known.switches = [{ id: 5, name: 'tf1', address: '10.0.0.2:50052', device_id: 2, proto_dump_file: null, target: 'tofino',
      target_options: options, register_adapter_enabled: false, register_thrift_host: null, register_thrift_port: null }];
    render(<SwitchHistory />);
    fireEvent.click(screen.getByTestId('EditIcon').closest('button'));
    expect(await screen.findByDisplayValue('tf1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit Edit' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalled());
    const config = JSON.parse(axios.patch.mock.calls[0][1].switch_config);
    expect(config).toMatchObject({ name: 'tf1', target: 'tofino', target_options: options });
  });

  it('keeps BMv2 register adapter settings', async () => {
    known.switches = [{ id: 6, name: 's1', address: '127.0.0.1:50051', device_id: 0, proto_dump_file: 's1_proto.log', target: 'bmv2',
      target_options: {}, register_adapter_enabled: true, register_thrift_host: '127.0.0.1', register_thrift_port: 9090 }];
    render(<SwitchHistory />);
    fireEvent.click(screen.getByTestId('EditIcon').closest('button'));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit Edit' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalled());
    expect(JSON.parse(axios.patch.mock.calls[0][1].switch_config)).toMatchObject({ target: 'bmv2', register_adapter_enabled: true,
      register_thrift_host: '127.0.0.1', register_thrift_port: 9090 });
  });
});
