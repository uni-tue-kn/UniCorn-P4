import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { APIProvider, useAPI } from './APIContext';
import { SwitchProvider, useSwitch } from './SwitchContext';
import { ThemeProviderWrapper, useTheme } from './ThemeContext';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); axios.get.mockResolvedValue({ data: { connections: [], switches_online: [] } }); });

function Status() { const status = useAPI(); return <p>{String(status.backendOnline)}:{String(status.mininetOnline)}</p>; }
function Selection() { const { currentSwitchID, setCurrentSwitchID } = useSwitch(); return <button onClick={() => setCurrentSwitchID(2)}>{String(currentSwitchID)}</button>; }
function Theme() { const { darkMode, toggleDarkMode } = useTheme(); return <button onClick={toggleDarkMode}>{darkMode ? 'dark' : 'light'}</button>; }

describe('UI state lifecycle', () => {
  it('polls status once on mount and ignores ordinary rerenders', async () => {
    const { rerender } = render(<APIProvider><Status /></APIProvider>);
    await screen.findByText('true:true');
    const count = axios.get.mock.calls.length;
    rerender(<APIProvider><Status /></APIProvider>);
    await act(async () => {});
    expect(axios.get.mock.calls.length).toBe(count);
    expect(count).toBe(2);
  });

  it('keeps emulator status independent when the controller is offline', async () => {
    axios.get.mockImplementation(url => url.startsWith('/netsim/') ? Promise.resolve({ data: {} }) : Promise.reject(new Error('offline')));
    render(<APIProvider><Status /></APIProvider>);
    await screen.findByText('false:true');
  });

  it('does not clear a newer switch selection from a stale response', async () => {
    let resolve;
    axios.get.mockImplementation(url => url === '/switches/active' ? new Promise(done => { resolve = done; }) : Promise.resolve({ data: { switches_online: [] } }));
    render(<SwitchProvider><Selection /></SwitchProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'null' }));
    await act(async () => resolve({ data: { connections: [], current_switch_connected: false } }));
    expect(screen.getByRole('button')).toHaveTextContent('2');
  });

  it('persists a false theme as light and preserves toggles on reload', async () => {
    localStorage.setItem('darkMode', 'false');
    const { unmount } = render(<ThemeProviderWrapper><Theme /></ThemeProviderWrapper>);
    await userEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(localStorage.getItem('darkMode')).toBe('true');
    unmount();
    render(<ThemeProviderWrapper><Theme /></ThemeProviderWrapper>);
    expect(screen.getByRole('button', { name: 'dark' })).toBeInTheDocument();
  });
});
