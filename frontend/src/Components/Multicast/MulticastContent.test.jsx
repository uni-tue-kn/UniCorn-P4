import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import MulticastContent, { validateGroup } from './MulticastContent';

vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ currentSwitchID: 0 }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), isCancel: () => false } }));
beforeEach(() => vi.clearAllMocks());

describe('multicast groups', () => {
  it('checks reserved IDs, zero ports and duplicate replicas while allowing empty groups', () => {
    const base = { multicast_group_id: '65535', replicas: [{ egress_port: '4294967295', instance: '65535' }] };
    expect(validateGroup(base)).toEqual({ multicast_group_id: 65535, replicas: [{ egress_port: '4294967295', instance: 65535 }] });
    expect(() => validateGroup({ ...base, multicast_group_id: '0' })).toThrow('Group ID');
    expect(() => validateGroup({ ...base, replicas: [{ egress_port: '0', instance: '0' }] })).toThrow('Egress port');
    expect(validateGroup({ ...base, replicas: [] })).toEqual({ multicast_group_id: 65535, replicas: [] });
    expect(() => validateGroup({ ...base, replicas: [...base.replicas, ...base.replicas] })).toThrow('unique');
  });
  it('creates, edits and deletes a multicast group from the form', async () => {
    let entries = [];
    axios.get.mockImplementation(async () => ({ data: { entries: structuredClone(entries) } }));
    axios.post.mockImplementation(async (_, data) => { const { switch_id, ...group } = data; entries.push(group); return { data: {} }; });
    axios.patch.mockImplementation(async (_, data) => { const { switch_id, ...group } = data; entries = [group]; return { data: {} }; });
    axios.delete.mockImplementation(async () => { entries = []; return { data: {} }; });
    const user = userEvent.setup();
    render(<MulticastContent />);
    await screen.findByText('No multicast groups configured.');
    await user.click(screen.getByRole('button', { name: 'Add multicast group' }));
    const dialog = screen.getByRole('dialog', { name: 'Add multicast group' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Group ID', exact: true }), '23');
    await user.type(within(dialog).getByRole('textbox', { name: 'Egress port 1', exact: true }), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Add replica' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Egress port 2', exact: true }), '3');
    await user.click(within(dialog).getByRole('button', { name: 'Save group' }));
    const row = await screen.findByTestId('multicast-group-23');
    expect(row).toHaveTextContent('2 / 0, 3 / 0');
    expect(axios.post).toHaveBeenCalledWith('/multicast-groups', { switch_id: 0, multicast_group_id: 23, replicas: [{ egress_port: '2', instance: 0 }, { egress_port: '3', instance: 0 }] });
    await user.click(await within(row).findByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit multicast group' });
    expect(within(edit).getByRole('textbox', { name: 'Group ID', exact: true })).toBeDisabled();
    await user.click(within(edit).getByRole('button', { name: 'Remove replica 2' }));
    await user.click(within(edit).getByRole('button', { name: 'Save group' }));
    await waitFor(() => expect(screen.getByTestId('multicast-group-23')).not.toHaveTextContent('3 / 0'));
    expect(axios.patch).toHaveBeenCalledWith('/multicast-groups', { switch_id: 0, multicast_group_id: 23, replicas: [{ egress_port: '2', instance: 0 }] });
    await user.click(await within(screen.getByTestId('multicast-group-23')).findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await screen.findByText('No multicast groups configured.');
    expect(axios.delete).toHaveBeenCalledWith('/multicast-groups', { data: { switch_id: 0, multicast_group_id: 23 } });
  });
  it('keeps the editor open for unsupported target errors', async () => {
    axios.get.mockResolvedValue({ data: { entries: [] } });
    axios.post.mockRejectedValue({ response: { status: 501, data: { error: 'Multicast is unsupported by this target' } } });
    const user = userEvent.setup();
    render(<MulticastContent />);
    await screen.findByText('No multicast groups configured.');
    await user.click(screen.getByRole('button', { name: 'Add multicast group' }));
    await user.type(screen.getByRole('textbox', { name: 'Group ID', exact: true }), '1');
    await user.type(screen.getByRole('textbox', { name: 'Egress port 1', exact: true }), '2');
    await user.click(screen.getByRole('button', { name: 'Save group' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported');
    expect(screen.getByRole('dialog', { name: 'Add multicast group' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Save failed');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('keeps the previous groups visible when a manual refresh fails', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { entries: [{ multicast_group_id: 7, replicas: [] }] } });
    render(<MulticastContent />);
    await screen.findByTestId('multicast-group-7');
    let reject;
    axios.get.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing…');
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByTestId('multicast-group-7')).toBeVisible();
    await act(async () => reject({ response: { data: { error: 'Multicast read failed' } } }));
    expect(screen.getByRole('status')).toHaveTextContent('Refresh failed');
    expect(screen.queryByText('Refreshed')).not.toBeInTheDocument();
    expect(screen.getByTestId('multicast-group-7')).toBeVisible();
  });
});
