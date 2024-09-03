import React, { useState, useEffect, useRef, useCallback } from 'react';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';
import { io } from 'socket.io-client';

import { useTopology } from '../../Contexts/TopologyContext';

// NOTE: Terminals are triggered and enabled based on the loadedHosts and loadedSwitches variable from the topology context
export default function MininetTerminal() {

  // FIrst line displayed in terminals
  const greeting = "Commands entered here are run directly on the mininet linux hosts.\nSend an interrupt via the red button (top left corner).\nType 'clear' to empty the current terminal.\n----\n\n";

  // What hosts can be accessed by the terminal
  const { loadedHosts, loadedSwitches } = useTopology();

  // Data storage for display and history
  const [terminalLineData, setTerminalLineData] = useState({});
  const [messageHistory, setMessageHistory] = useState({});

  // Websocket to backend
  const [socket, setSocket] = useState(null);

  function clearTerminal(host) {
    if (!(host in terminalLineData)) {
      console.log("Cannot clear terminal for invalid host: ", host)
      return
    }

    // Only clear host key of terminal data, not history
    setTerminalLineData(
      (previousState) => {
        return {
          ...previousState,
          [host]: [greeting]
        }
      }
    );

  }

  // TODO: this should get moved to a context, otherwise the terminals clear input when page is left
  function appendLineData(host, newEntry) {

    if (!(host in terminalLineData)) {
      console.log("ENTRY: ", newEntry, "for invbalid host: ", host)
      return
    }
    // Update key host of state dict
    setTerminalLineData(
      (previousState) => {
        return {
          ...previousState,
          [host]: [...previousState[host], newEntry]
        }
      }
    );

    // Update key host of state dict
    setMessageHistory(
      (previousState) => {
        return {
          ...previousState,
          [host]: [...previousState[host], newEntry]
        }
      }
    );
  }


  // Update when loaded hosts changes
  useEffect(() => {
    const updatedData = {};
    const updatedHistory = {};

    loadedHosts.forEach(element => {
      updatedData[element] = [greeting];
      updatedHistory[element] = [greeting];
    });

    loadedSwitches.forEach(element => {
      updatedData[element] = [greeting];
      updatedHistory[element] = [greeting];
    });    

    setTerminalLineData(updatedData);
    setMessageHistory(updatedHistory);

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

  function handleResponse(message) {
    const parsed = JSON.parse(message)
    appendLineData(parsed.name, parsed.data);

  }

  // When data changes, set new handle response function for socket callback
  useEffect(() => {
    if (!(socket === null)) {
      // Unregister any old listener
      socket.removeAllListeners("response");
      // Add the new listener
      // Handle response will have the correct references to the terminalLine and history states
      socket.on('response', handleResponse);
    }
  }, [handleResponse])


  function handleInput(host, text) {

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

    // Send input to backend
    socket.send(to_send);
  }

  function handleInterrupt(host) {
    const to_send = {
      "interrupt": true,
      "target": host
    };
    socket.send(to_send);

    appendLineData(host, "SENDING INTERRUPT");
  }

  // Main Terminal window
  return (
    <div className="container" style={{ padding: 5 + "px" }}>
      {
        loadedHosts.map((host, index) => (
          <div className="container" style={{ padding: 5 + "px" }}>
            <Terminal name={host} colorMode={ColorMode.Dark} redBtnCallback={(event) => handleInterrupt(host)} onInput={(text) => handleInput(host, text)}>
              {
                // Add per host if it already exists in the data
                (host in terminalLineData) && terminalLineData[host].map((line, index) => (
                  <TerminalOutput key={index}>{line}</TerminalOutput>
                ))}
            </Terminal>
          </div>
        ))}
        {
        loadedSwitches.map((host, index) => (
          <div className="container" style={{ padding: 5 + "px" }}>
            <Terminal name={host} colorMode={ColorMode.Dark} redBtnCallback={(event) => handleInterrupt(host)} onInput={(text) => handleInput(host, text)}>
              {
                // Add per host if it already exists in the data
                (host in terminalLineData) && terminalLineData[host].map((line, index) => (
                  <TerminalOutput key={index}>{line}</TerminalOutput>
                ))}
            </Terminal>
          </div>
        ))}
    </div>
  )
}