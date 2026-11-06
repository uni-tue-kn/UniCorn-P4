import React from 'react';
import { expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import TopologyBuilder from './TopologyBuilder';
import { TopologyProvider } from '../../../Contexts/TopologyContext';
vi.mock('../../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ getSwitches: vi.fn(), getSwitchesOnline: vi.fn(), getHistorySwitches: vi.fn() }) }));
vi.mock('../../../Contexts/SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: vi.fn() }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
it('keeps deployment warnings visible after refreshing the active topology', async () => {
  sessionStorage.clear();
  const user = userEvent.setup();
  let loaded = { file_name: null };
  axios.post.mockImplementation((url, body) => {
    if (url === '/topologies') {
      loaded = { ...body.topology, file_name: '/topologies/' + body.name, switches_online: [{ name:'s1', dev_id:0, grpc_port:50051, thrift_port:9090 }], interface_mapping:{} };
      return Promise.resolve({ data: { name: loaded.file_name } });
    }
    return Promise.resolve({ data: url === '/netsim/topology/deploy' ? { deployment_id:'job1' } : [] });
  });
  axios.get.mockImplementation(url => Promise.resolve({ data: url === '/topologies' ? { topologies:[] }
    : url === '/netsim/topology/get' ? loaded : { status:'ready', topology:loaded, warnings:['Terminals could not be initialized: terminal unavailable'] } }));
  render(<TopologyProvider><TopologyBuilder /></TopologyProvider>);
  await act(async () => {});
  await user.click(screen.getByRole('button', { name:'Add switch' }));
  await user.click(screen.getByRole('button', { name:'Deploy topology' }));
  await waitFor(() => expect(axios.get.mock.calls.filter(([url]) => url === '/netsim/topology/get').length).toBeGreaterThanOrEqual(2));
  await act(async () => {});
  expect(screen.queryByText('Topology deployed. Terminals could not be initialized: terminal unavailable')).toBeInTheDocument();
});
