import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useTopology } from './TopologyContext';

export const TERMINAL_GREETING = "Commands entered here are run directly on the Mininet hosts and switches.\nCtrl+C: Interrupt  |  Shift+Ctrl+V: Paste clipboard  |  Type 'clear' to empty terminal\n----\n\n";
const TerminalContext = createContext(null);
export const useTerminal = () => useContext(TerminalContext);
const MAX_ENTRIES = 1000, MAX_CHARACTERS = 256 * 1024;
const EMPTY_TARGETS = [];

function boundedOutput(previous, entry) {
  const entries = [...previous, entry.slice(-MAX_CHARACTERS)];
  let length = 0, start = entries.length;
  while (start > 0 && entries.length - start < MAX_ENTRIES && length + entries[start - 1].length <= MAX_CHARACTERS) {
    start--; length += entries[start].length;
  }
  return entries.slice(start);
}

export function TerminalProvider({ children }) {
  const { loadedHosts = EMPTY_TARGETS, loadedSwitches = EMPTY_TARGETS, currentTopologyName = '' } = useTopology() || {};
  const terminalTargets = useMemo(() => [
    ...loadedHosts.map(name => ({ name, type: 'Host' })),
    ...loadedSwitches.map(name => ({ name, type: 'Switch' })),
  ], [loadedHosts, loadedSwitches]);
  const targets = useRef(new Set());
  targets.current = new Set(terminalTargets.map(target => target.name));
  const network = useRef(currentTopologyName);
  const [terminalLineData, setTerminalLineData] = useState({});
  const [activeTerminal, setActiveTerminal] = useState(null);
  const [connected, setConnected] = useState(false);
  const socket = useRef(null);

  useEffect(() => {
    const sameNetwork = network.current === currentTopologyName;
    network.current = currentTopologyName;
    setTerminalLineData(previous => Object.fromEntries(terminalTargets.map(({ name }) =>
      [name, sameNetwork && previous[name] ? previous[name] : [TERMINAL_GREETING]])));
    setActiveTerminal(previous => targets.current.has(previous) ? previous : terminalTargets[0]?.name || null);
  }, [currentTopologyName, terminalTargets]);

  const append = useCallback((name, data) => {
    if (!targets.current.has(name) || typeof data !== 'string') return;
    setTerminalLineData(previous => ({ ...previous,
      [name]: boundedOutput(previous[name] || [TERMINAL_GREETING], data) }));
  }, []);

  useEffect(() => {
    const connection = io(window.location.origin, { path: '/netsim/socket.io', transports: ['websocket'] });
    socket.current = connection;
    setConnected(Boolean(connection.connected));
    connection.on('connect', () => setConnected(true));
    connection.on('disconnect', () => setConnected(false));
    connection.on('response', message => {
      try {
        const payload = typeof message === 'string' ? JSON.parse(message) : message;
        if (payload && typeof payload.name === 'string') append(payload.name, payload.data);
      } catch { /* An incomplete or malformed message never breaks other terminals. */ }
    });
    return () => { socket.current = null; connection.close(); };
  }, [append]);

  const handleInput = useCallback((host, text) => {
    if (!targets.current.has(host) || typeof text !== 'string' || !text.trim()) return;
    if (text === 'clear') {
      setTerminalLineData(previous => ({ ...previous, [host]: [TERMINAL_GREETING] }));
      return;
    }
    append(host, '$ ' + text);
    if (!socket.current?.connected) { append(host, 'Terminal backend is not connected. Try again after it reconnects.'); return; }
    socket.current.send({ target: host, cmd: text });
  }, [append]);
  const handleInterrupt = useCallback(host => {
    if (!targets.current.has(host)) return;
    if (!socket.current?.connected) { append(host, 'Terminal backend is not connected.'); return; }
    socket.current.send({ interrupt: true, target: host });
    append(host, 'SENDING INTERRUPT');
  }, [append]);

  return <TerminalContext.Provider value={{ terminalTargets, terminalLineData, activeTerminal,
    setActiveTerminal, handleInput, handleInterrupt, connected }}>{children}</TerminalContext.Provider>;
}
