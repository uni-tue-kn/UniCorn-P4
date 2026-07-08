import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Box, Paper, Tab, Tabs, Typography } from '@mui/material';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';
import { io } from 'socket.io-client';

import { useTopology } from '../../Contexts/TopologyContext';

const GREETING = "Commands entered here are run directly on the mininet linux hosts.\nCtrl+C: Interrupt  |  Shift+Ctrl+V: Paste clipboard  |  Type 'clear' to empty terminal\n----\n\n";

// NOTE: Terminals are triggered and enabled based on the loadedHosts and loadedSwitches variable from the topology context
export default function MininetTerminal() {

  // What hosts can be accessed by the terminal
  const { loadedHosts, loadedSwitches } = useTopology();

  // Data storage for display
  const [terminalLineData, setTerminalLineData] = useState({});
  const [activeTerminal, setActiveTerminal] = useState(null);

  // Websocket to backend
  const [socket, setSocket] = useState(null);

  const terminalTargets = useMemo(() => [
    ...loadedHosts.map((name) => ({ name, type: 'Host' })),
    ...loadedSwitches.map((name) => ({ name, type: 'Switch' })),
  ], [loadedHosts, loadedSwitches]);

  const clearTerminal = useCallback((host) => {
    setTerminalLineData((previousState) => {
      if (!(host in previousState)) {
        console.log("Cannot clear terminal for invalid host: ", host);
        return previousState;
      }

      return {
        ...previousState,
        [host]: [GREETING],
      };
    });
  }, []);

  // TODO: this should get moved to a context, otherwise the terminals clear input when page is left
  const appendLineData = useCallback((host, newEntry) => {
    setTerminalLineData((previousState) => {
      if (!(host in previousState)) {
        console.log("ENTRY: ", newEntry, "for invalid host: ", host);
        return previousState;
      }

      return {
        ...previousState,
        [host]: [...previousState[host], newEntry],
      };
    });

  }, []);

  // Update when loaded hosts changes
  useEffect(() => {
    const updatedData = {};
    const terminals = [...loadedHosts, ...loadedSwitches];

    loadedHosts.forEach(element => {
      updatedData[element] = [GREETING];
    });

    loadedSwitches.forEach(element => {
      updatedData[element] = [GREETING];
    });    

    setTerminalLineData(updatedData);
    setActiveTerminal((currentTerminal) => {
      if (terminals.includes(currentTerminal)) {
        return currentTerminal;
      }

      return terminals[0] || null;
    });

  }, [loadedHosts, loadedSwitches]);

  useEffect(() => {

    // Connect to the Flask-SocketIO server
    // TODO: this should be moved to a context component
    const newSocket = io('http://127.0.0.1:5001', {
      transports: ['websocket'],
    });

    // Save the socket instance
    setSocket(newSocket);

    //newSocket.on('response', handleResponse);

    // Clean up the connection when the component unmounts
    return () => {
      newSocket.close();
    };
  }, []);

  const handleResponse = useCallback((message) => {
    const parsed = JSON.parse(message);
    appendLineData(parsed.name, parsed.data);
  }, [appendLineData]);

  // When data changes, set new handle response function for socket callback
  useEffect(() => {
    if (!(socket === null)) {
      // Unregister any old listener
      socket.removeAllListeners("response");
      // Add the new listener
      // Handle response will have the correct references to the terminalLine and history states
      socket.on('response', handleResponse);
    }
  }, [socket, handleResponse])


  function handleInput(host, text) {
    if (!host) {
      return;
    }

    // CLear terminal is only handled in frontend, do not send
    if (text === "clear") {
      clearTerminal(host);
      return
    }

    // Add Input to history and current terminal
    appendLineData(host, "$ " + text);

    const to_send = {
      "target": host,
      "cmd": text
    };

    if (socket === null) {
      appendLineData(host, "Terminal backend is not connected.");
      return;
    }

    // Send input to backend
    socket.send(to_send);
  }

  function handleKeyDown(host, event) {
    if (event.ctrlKey && event.key === 'c') {
      event.preventDefault();
      event.stopPropagation();
      handleInterrupt(host);
    }
  }

  function handleInterrupt(host) {
    if (!host) {
      return;
    }

    const to_send = {
      "interrupt": true,
      "target": host
    };

    if (socket === null) {
      appendLineData(host, "Terminal backend is not connected.");
      return;
    }

    socket.send(to_send);

    appendLineData(host, "SENDING INTERRUPT");
  }

  // Main Terminal window
  const selectedTerminal = activeTerminal || terminalTargets[0]?.name || null;

  return (
    <Paper sx={{ padding: '32px' }} elevation={3}>
      <Typography variant='h6' gutterBottom>Terminals</Typography>

      {terminalTargets.length === 0 ? (
        <Typography color='text.secondary'>
          Load a topology to open host and switch terminals.
        </Typography>
      ) : (
        <>
          <Tabs
            value={selectedTerminal || false}
            onChange={(event, selectedTerminal) => setActiveTerminal(selectedTerminal)}
            variant='scrollable'
            scrollButtons='auto'
            sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
          >
            {terminalTargets.map((target) => (
              <Tab
                key={target.name}
                value={target.name}
                label={`${target.name} (${target.type})`}
              />
            ))}
          </Tabs>

          <Box onKeyDownCapture={(event) => handleKeyDown(selectedTerminal, event)}>
            <Terminal
              name={selectedTerminal}
              colorMode={ColorMode.Dark}
              redBtnCallback={() => handleInterrupt(selectedTerminal)}
              onInput={(text) => handleInput(selectedTerminal, text)}
            >
              {(selectedTerminal && selectedTerminal in terminalLineData) && terminalLineData[selectedTerminal].map((line, index) => (
                <TerminalOutput key={index}>{line}</TerminalOutput>
              ))}
            </Terminal>
          </Box>
        </>
      )}
    </Paper>
  )
}
