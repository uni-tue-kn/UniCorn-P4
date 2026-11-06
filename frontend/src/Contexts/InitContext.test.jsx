import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import axios from 'axios';
import { InitProvider, useInit } from './InitContext';

const switchState = vi.hoisted(() => ({ currentSwitchID: 1 }));
vi.mock('./SwitchContext', () => ({ useSwitch: () => switchState }));
vi.mock('./SnackbarContext', () => ({ useSnackbar: () => ({ callSnackbar: vi.fn() }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
function Loaded() { const { initializedFiles } = useInit(); return <p>{initializedFiles?.name || 'No pipeline'}</p>; }
beforeEach(() => { switchState.currentSwitchID = 1; vi.clearAllMocks(); });
describe('pipeline metadata follows selected switch', () => {
  it('rejects initialization and saved-state restore locally on a read-only connection', async () => {
    let api;
    function Editor() { api = useInit(); return <Loaded />; }
    axios.get.mockResolvedValue({ data: { name: 'Observed program', capabilities: { pipeline: { write: false } } } });
    render(<InitProvider><Editor /></InitProvider>);
    await screen.findByText('Observed program');
    await act(async () => { expect(await api.initialize(null, { id: '/p4/manifest.json' }, null, false, 7)).toBe(false); });
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('reports initialization success or failure to its editor', async () => {
    let api;
    function Editor() { api = useInit(); return <Loaded />; }
    axios.get.mockResolvedValue({ data: { name: 'Current pipeline' } });
    axios.post.mockResolvedValue({ data: '' });
    render(<InitProvider><Editor /></InitProvider>);
    await act(async () => { expect(await api.initialize(null, '/p4/info.txt', '/p4/program.json')).toBe(true); });
    axios.post.mockRejectedValue({ response: { data: { error: 'Wrong pipeline' } } });
    await act(async () => { expect(await api.initialize(null, '/p4/info.txt', '/p4/program.json')).toBe(false); });
    expect(screen.getByText('Current pipeline')).toBeVisible();
  });
  it('sends a compiled program identity for either target', async () => {
    let api;
    function Editor() { api = useInit(); return <Loaded />; }
    axios.get.mockResolvedValue({ data: {} });
    axios.post.mockResolvedValue({ data: {} });
    render(<InitProvider><Editor /></InitProvider>);
    for (const target of ['bmv2', 'tofino']) {
      await act(async () => { expect(await api.initialize(null, { id: '/p4/program', target, build_manifest: '/p4/program' }, null, false)).toBe(true); });
      expect(axios.post).toHaveBeenLastCalledWith('/init', { switch_id: 1, program_id: '/p4/program', keep_entries: false });
    }
  });
  it('drops a late response for the previously selected switch', async () => {
    const resolve = {};
    axios.get.mockImplementation((_, config) => new Promise(done => { resolve[config.params.switch_id] = done; }));
    const view = render(<InitProvider><Loaded /></InitProvider>);
    switchState.currentSwitchID = 2;
    view.rerender(<InitProvider><Loaded /></InitProvider>);
    await act(async () => resolve[2]({ data: { name: 'Switch two' } }));
    await act(async () => resolve[1]({ data: { name: 'Switch one' } }));
    expect(screen.getByText('Switch two')).toBeVisible();
    switchState.currentSwitchID = null;
    view.rerender(<InitProvider><Loaded /></InitProvider>);
    expect(screen.getByText('No pipeline')).toBeVisible();
  });
});
