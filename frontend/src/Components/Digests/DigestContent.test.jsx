import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import DigestContent, { validateDigestConfig } from './DigestContent';

const contexts = vi.hoisted(() => ({ digests: { learn: { id: 394223234, name: 'traffic_digest_t', alias: 'traffic_digest_t' } } }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ currentSwitchID: 0 }) }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ initializedFiles: { digests: contexts.digests } }) }));
vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), isCancel: () => false } }));
const stream = { primary: true, active: true, error: null };
const event = { sequence: '1', digest_id: 394223234, list_id: '18446744073709551615', timestamp_ns: '9007199254740993', received_at: '2026-10-31T12:00:00+00:00', data: [{ kind: 'struct', name: 'traffic_digest_t', fields: { source_mac: { kind: 'bit', decimal: '187723572702975', hex: '0xaabbccddeeff', bitwidth: 48 } } }] };
beforeEach(() => {
  vi.clearAllMocks();
  contexts.digests = { learn: { id: 394223234, name: 'traffic_digest_t', alias: 'traffic_digest_t' } };
});

describe('digests', () => {
  it('keeps nanosecond values lossless and validates protocol limits', () => {
    const config = { max_timeout_ns: '9007199254740993', max_list_size: '1', ack_timeout_ns: '9223372036854775807' };
    expect(validateDigestConfig(config)).toEqual(config);
    expect(validateDigestConfig({ ...config, max_list_size: '0' }).max_list_size).toBe('0');
    expect(() => validateDigestConfig({ ...config, max_list_size: '-1' })).toThrow('max_list_size');
    expect(() => validateDigestConfig({ ...config, max_timeout_ns: '1.5' })).toThrow('max_timeout_ns');
    expect(() => validateDigestConfig({ ...config, ack_timeout_ns: '9223372036854775808' })).toThrow('ack_timeout_ns');
  });
  it('enables, updates and disables a digest while showing decoded captured events', async () => {
    let config = null;
    let events = [event];
    axios.get.mockImplementation(async url => ({ data: url === '/digests' ? { entries: config ? [{ digest_id: 394223234, config }] : [] }
      : { events, next_sequence: '1', dropped: 0, stream, limits: {} } }));
    axios.post.mockImplementation(async (_, data) => { config = data.config; return { data: {} }; });
    axios.patch.mockImplementation(async (_, data) => { config = data.config; return { data: {} }; });
    axios.delete.mockImplementation(async url => { if (url === '/digests') config = null; else events = []; return { data: {} }; });
    const user = userEvent.setup();
    render(<DigestContent />);
    await screen.findByText('Disabled');
    expect(await screen.findByTestId('digest-event-1')).toHaveTextContent('source_mac');
    expect(screen.getByTestId('digest-event-1')).toHaveTextContent('187723572702975');
    expect(screen.getByTestId('digest-event-1')).not.toHaveTextContent('18446744073709551615');
    await user.click(within(screen.getByTestId('digest-event-1')).getByRole('button', { name: 'Details' }));
    expect(screen.getByTestId('digest-event-1')).toHaveTextContent('18446744073709551615');
    await user.click(screen.getByRole('button', { name: 'Enable digest' }));
    await screen.findByText('Enabled');
    expect(axios.post).toHaveBeenCalledWith('/digests', { switch_id: 0, digest_id: 394223234, config: { max_timeout_ns: '0', max_list_size: '1', ack_timeout_ns: '1000000000' } });
    const timeout = screen.getByRole('textbox', { name: 'Maximum timeout (ns)', exact: true });
    await user.clear(timeout); await user.type(timeout, '9007199254740993');
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(axios.patch).toHaveBeenCalledWith('/digests', expect.objectContaining({ config: expect.objectContaining({ max_timeout_ns: '9007199254740993' }) })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disable digest' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Disable digest' }));
    await user.click(screen.getByRole('button', { name: 'Confirm disable' }));
    await screen.findByText('Disabled');
    expect(screen.getByTestId('digest-event-1')).toBeVisible();
    expect(axios.delete).toHaveBeenCalledWith('/digests', { data: { switch_id: 0, digest_id: 394223234 } });
    await user.click(await screen.findByRole('button', { name: 'Clear events' }));
    await screen.findByText('No digest events captured.');
    expect(axios.delete).toHaveBeenCalledWith('/digest-events', { data: { switch_id: 0, digest_id: 394223234 } });
  });
  it('shows stream problems, overflow and unsupported target errors', async () => {
    axios.get.mockImplementation(async url => {
      if (url === '/digests') throw { response: { status: 501, data: { error: 'Digests are unsupported by this target' } } };
      return { data: { events: [], next_sequence: '0', dropped: 5, stream: { primary: false, active: true, error: 'Another controller is primary' } } };
    });
    render(<DigestContent />);
    expect(await screen.findByText('Digests are unsupported by this target')).toBeVisible();
    expect(await screen.findByText('Another controller is primary')).toBeVisible();
    expect(screen.getByText('5 list(s) were rejected or evicted from the capture buffer.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Enable digest' })).toBeDisabled();
  });
  it('explains when the loaded program declares no digest instances', () => {
    contexts.digests = {};
    render(<DigestContent />);
    expect(screen.getByRole('alert')).toHaveTextContent('declares no digests');
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('shows nested field values compactly and hides typed metadata until Details is opened', async () => {
    const user = userEvent.setup();
    const nested = { ...event, data: [{ kind: 'struct', name: 'traffic_digest_t', fields: {
      flow: { kind: 'struct', fields: {
        counter: { kind: 'bit', bitwidth: 64, decimal: '18446744073709551615', hex: '0xffffffffffffffff' },
        active: { kind: 'bool', value: false },
        pair: { kind: 'tuple', members: [{ kind: 'bit', decimal: '7', hex: '0x07' }, { kind: 'bool', value: true }] },
      } },
    } }] };
    axios.get.mockImplementation(async url => ({ data: url === '/digests' ? { entries: [] } : { events: [nested], next_sequence: '1', dropped: 0, stream } }));
    render(<DigestContent />);
    const card = await screen.findByTestId('digest-event-1');
    expect(card).toHaveTextContent('flow.counter');
    expect(card).toHaveTextContent('18446744073709551615');
    expect(card).toHaveTextContent('flow.active');
    expect(card).toHaveTextContent('false');
    expect(card).toHaveTextContent('flow.pair[0]');
    expect(card).toHaveTextContent('flow.pair[1]');
    expect(card.querySelector('pre')).toBeNull();
    expect(card).not.toHaveTextContent('bitwidth');
    expect(card).not.toHaveTextContent('0xffffffffffffffff');
    await user.click(within(card).getByRole('button', { name: 'Details' }));
    expect(card.querySelector('pre')).toHaveTextContent('bitwidth');
    expect(card.querySelector('pre')).toHaveTextContent('0xffffffffffffffff');
    expect(card.querySelector('pre')).toHaveTextContent('9007199254740993');
    await user.click(within(card).getByRole('button', { name: 'Details' }));
    expect(card.querySelector('pre')).toBeNull();
  });

  it('gives manual feedback when refreshing joins a pending automatic event read', async () => {
    let resolve;
    axios.get.mockImplementation(url => url === '/digests' ? Promise.resolve({ data: { entries: [] } }) : new Promise(done => { resolve = done; }));
    const user = userEvent.setup();
    render(<DigestContent />);
    await screen.findByText('Disabled');
    await user.click(screen.getByRole('button', { name: 'Refresh events' }));
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    const panel = screen.getByRole('heading', { name: 'Captured events' }).closest('.MuiPaper-root');
    expect(within(panel).getByRole('status')).toHaveTextContent('Refreshing…');
    expect(axios.get).toHaveBeenCalledTimes(2);
    await act(async () => resolve({ data: { events: [event], next_sequence: '1', dropped: 0, stream } }));
    expect(within(panel).getByRole('status')).toHaveTextContent('Refreshed');
    expect(screen.getByTestId('digest-event-1')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh events' })).toBeEnabled();
  });

  it('does not show Saved when enabling a digest fails', async () => {
    let reject;
    axios.get.mockImplementation(async url => ({ data: url === '/digests' ? { entries: [] } : { events: [], next_sequence: '0', dropped: 0, stream } }));
    axios.post.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const user = userEvent.setup();
    render(<DigestContent />);
    await screen.findByText('Disabled');
    await user.click(screen.getByRole('button', { name: 'Enable digest' }));
    const panel = screen.getByRole('heading', { name: 'Digest configuration' }).closest('.MuiPaper-root');
    expect(within(panel).getByRole('status')).toHaveTextContent('Saving…');
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await act(async () => reject({ response: { data: { error: 'Digest write rejected' } } }));
    expect(within(panel).getByRole('status')).toHaveTextContent('Save failed');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    expect(screen.getByText('Digest write rejected')).toBeVisible();
  });
});
