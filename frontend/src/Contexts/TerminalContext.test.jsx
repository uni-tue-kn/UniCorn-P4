import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TerminalProvider, TERMINAL_GREETING, useTerminal } from './TerminalContext';
import { io } from 'socket.io-client';

const socket = vi.hoisted(() => ({ connected: true, on: vi.fn(), close: vi.fn(), send: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: vi.fn(() => socket) }));
let topology, listeners, terminal;
vi.mock('./TopologyContext', () => ({ useTopology: () => topology }));

function Probe() {
  terminal = useTerminal();
  return <pre data-testid="transcript">{JSON.stringify(terminal.terminalLineData)}</pre>;
}
function Pages() {
  const [visible, setVisible] = useState(true);
  return <TerminalProvider><button onClick={() => setVisible(value => !value)}>Change page</button>{visible && <Probe />}</TerminalProvider>;
}
beforeEach(() => {
  vi.clearAllMocks(); listeners = {}; socket.connected = true;
  socket.on.mockImplementation((name, callback) => { listeners[name] = callback; return socket; });
  topology = { loadedHosts: ['h1', 'h2'], loadedSwitches: ['s1'], currentTopologyName: '/topologies/first.json' };
});

it('keeps selection, socket, and output received while the terminal page is absent', () => {
  const view = render(<Pages />);
  act(() => { terminal.setActiveTerminal('h2'); terminal.handleInput('h2', 'echo hello'); });
  expect(socket.send).toHaveBeenCalledWith({ target: 'h2', cmd: 'echo hello' });
  fireEvent.click(screen.getByRole('button', { name: 'Change page' }));
  act(() => listeners.response(JSON.stringify({ name: 'h2', data: 'hello while away\n' })));
  fireEvent.click(screen.getByRole('button', { name: 'Change page' }));
  expect(terminal.activeTerminal).toBe('h2');
  expect(screen.getByTestId('transcript')).toHaveTextContent('hello while away');
  expect(io).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(socket.close).toHaveBeenCalledTimes(1);
});

it('preserves output on a topology refresh and clears it when the running network changes', () => {
  const view = render(<TerminalProvider><Probe /></TerminalProvider>);
  act(() => listeners.response({ name: 'h1', data: 'old network output' }));
  topology = { ...topology, loadedHosts: [...topology.loadedHosts], loadedSwitches: [...topology.loadedSwitches] };
  view.rerender(<TerminalProvider><Probe /></TerminalProvider>);
  expect(screen.getByTestId('transcript')).toHaveTextContent('old network output');
  topology = { ...topology, currentTopologyName: '/topologies/replacement.json' };
  view.rerender(<TerminalProvider><Probe /></TerminalProvider>);
  expect(terminal.terminalLineData.h1).toEqual([TERMINAL_GREETING]);
  expect(screen.getByTestId('transcript')).not.toHaveTextContent('old network output');
});

it('ignores malformed and unknown-target messages and bounds stored output', () => {
  render(<TerminalProvider><Probe /></TerminalProvider>);
  act(() => {
    listeners.response('{broken JSON');
    listeners.response({ name: 'unknown', data: 'unrelated output' });
    listeners.response({ name: 'h1', data: { unsupported: true } });
    listeners.response({ name: 'h1', data: 'x'.repeat(300000) + 'TAIL' });
  });
  expect(Object.keys(terminal.terminalLineData)).toEqual(['h1', 'h2', 's1']);
  const output = terminal.terminalLineData.h1.join('');
  expect(output.length).toBeLessThanOrEqual(256 * 1024);
  expect(output.endsWith('TAIL')).toBe(true);
});

it('does not queue disconnected commands and clears or interrupts only the chosen terminal', () => {
  render(<TerminalProvider><Probe /></TerminalProvider>);
  act(() => {
    listeners.response({ name: 'h2', data: 'keep this' });
    socket.connected = false; listeners.disconnect();
    terminal.handleInput('h1', 'ping example');
  });
  expect(socket.send).not.toHaveBeenCalled();
  expect(terminal.connected).toBe(false);
  expect(terminal.terminalLineData.h1.join('')).toContain('not connected');
  act(() => terminal.handleInput('h1', 'clear'));
  expect(terminal.terminalLineData.h1).toEqual([TERMINAL_GREETING]);
  expect(terminal.terminalLineData.h2.join('')).toContain('keep this');
  act(() => { socket.connected = true; listeners.connect(); terminal.handleInterrupt('h2'); });
  expect(socket.send).toHaveBeenCalledExactlyOnceWith({ interrupt: true, target: 'h2' });
});
