import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import VersionInfo from './VersionInfo';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ switches: [{ name: 's1', device_id: 0, p4runtime_api_version: '1.3.0' }] }) }));
beforeEach(() => vi.clearAllMocks());
describe('component versions and startup update status', () => {
  it('shows each separately installed component version and an available update', async () => {
    axios.get.mockImplementation(url => Promise.resolve({ data: url === '/version' ? { version: '1.2.0', runtime: { p4runtime: '1.5.0' }, update: { status: 'checked', latest_version: '1.3.0', update_available: true, url: 'https://github.com/uni-tue-kn/UniCorn-P4' } } : { version: '1.1.0' } }));
    render(<VersionInfo />);
    await screen.findByText(/Update available/);
    await userEvent.click(screen.getByRole('button', { name: 'Component versions' }));
    expect(screen.getByText('Frontend')).toBeVisible();
    expect(within(screen.getByText('Backend').closest('li')).getByText('1.2.0')).toBeVisible();
    expect(within(screen.getByText('Network emulator').closest('li')).getByText('1.1.0')).toBeVisible();
    expect(screen.getByText('p4runtime: 1.5.0')).toBeVisible();
    expect(screen.getByText('s1: P4Runtime 1.3.0')).toBeVisible();
    expect(screen.getByRole('link', { name: 'View update' })).toHaveAttribute('href', 'https://github.com/uni-tue-kn/UniCorn-P4');
  });
  it('still opens and shows unavailable services while offline', async () => {
    axios.get.mockRejectedValue(new Error('offline'));
    render(<VersionInfo />);
    await userEvent.click(screen.getByRole('button', { name: 'Component versions' }));
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    expect(screen.queryByText(/Update available/)).not.toBeInTheDocument();
  });
});
