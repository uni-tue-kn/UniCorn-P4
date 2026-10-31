import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import MirrorContent, { validateSession } from './MirrorContent';

vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ currentSwitchID: 0 }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), isCancel: () => false } }));
beforeEach(() => vi.clearAllMocks());
const base = { session_id: '7', replicas: [{ egress_port: '4294967295', instance: '0' }], class_of_service: '0', packet_length_bytes: '0' };

describe('mirror sessions', () => {
  it('validates session ranges and duplicate replicas before issuing a write', () => {
    expect(validateSession(base).replicas[0].egress_port).toBe('4294967295');
    expect(() => validateSession({ ...base, session_id: '0' })).toThrow('Session ID');
    expect(() => validateSession({ ...base, replicas: [...base.replicas, ...base.replicas] })).toThrow('unique');
  });
  it('creates, edits and deletes a session through the UI', async () => {
    let entries = [];
    axios.get.mockImplementation(async () => ({ data: { entries: structuredClone(entries) } }));
    axios.post.mockImplementation(async (_, data) => { const { switch_id, ...session } = data; entries.push(session); return { data: { success: true } }; });
    axios.patch.mockImplementation(async (_, data) => { const { switch_id, ...session } = data; entries = [session]; return { data: { success: true } }; });
    axios.delete.mockImplementation(async () => { entries = []; return { data: { success: true } }; });
    const user = userEvent.setup();
    render(<MirrorContent />);
    await screen.findByText('No mirror sessions configured.');
    await user.click(screen.getByRole('button', { name: 'Add mirror session' }));
    const dialog = screen.getByRole('dialog', { name: 'Add mirror session' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Session ID', exact: true }), '7');
    await user.type(within(dialog).getByRole('textbox', { name: 'Egress port 1', exact: true }), '2');
    await user.click(within(dialog).getByRole('button', { name: 'Save session' }));
    const row = await screen.findByTestId('mirror-session-7');
    expect(axios.post).toHaveBeenCalledWith('/mirrors', { switch_id: 0, session_id: 7, replicas: [{ egress_port: '2', instance: 0 }], class_of_service: 0, packet_length_bytes: 0 });
    await user.click(await within(row).findByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit mirror session' });
    expect(within(edit).getByRole('textbox', { name: 'Session ID', exact: true })).toBeDisabled();
    const port = within(edit).getByRole('textbox', { name: 'Egress port 1', exact: true });
    await user.clear(port); await user.type(port, '3');
    await user.click(within(edit).getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(screen.getByTestId('mirror-session-7')).toHaveTextContent('3 / 0'));
    expect(axios.patch).toHaveBeenCalledWith('/mirrors', expect.objectContaining({ session_id: 7, replicas: [{ egress_port: '3', instance: 0 }] }));
    await user.click(await within(screen.getByTestId('mirror-session-7')).findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await screen.findByText('No mirror sessions configured.');
    expect(axios.delete).toHaveBeenCalledWith('/mirrors', { data: { switch_id: 0, session_id: 7 } });
  });
  it('shows the target error without discarding the editor', async () => {
    const user = userEvent.setup();
    axios.get.mockResolvedValue({ data: { entries: [{ session_id: 7, replicas: [{ egress_port: '2', instance: 0 }], class_of_service: 0, packet_length_bytes: 0 }] } });
    axios.patch.mockRejectedValue({ response: { status: 501, data: { error: 'Class of service is unsupported by this target' } } });
    render(<MirrorContent />);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Save session' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported by this target');
    expect(screen.getByRole('dialog', { name: 'Edit mirror session' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Save failed');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('explains the P4 clone requirement and reports pending refresh without hiding sessions', async () => {
    const user = userEvent.setup();
    const entries = [{ session_id: 7, replicas: [{ egress_port: '2', instance: 0 }], class_of_service: 0, packet_length_bytes: 0 }];
    axios.get.mockResolvedValue({ data: { entries } });
    render(<MirrorContent />);
    await screen.findByTestId('mirror-session-7');
    expect(screen.getByText(/Configuration alone does not mirror traffic/)).toHaveTextContent('Original forwarding is still decided by the program');
    expect(screen.getByText(/Configuration alone does not mirror traffic/)).toHaveTextContent('session 10 with port 3');
    let resolve;
    axios.get.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    expect(screen.getByTestId('mirror-session-7')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing…');
    await act(async () => resolve({ data: { entries } }));
    expect(screen.getByRole('status')).toHaveTextContent('Refreshed');
    expect(screen.getByText(/Last updated:/)).toBeVisible();
  });
});
