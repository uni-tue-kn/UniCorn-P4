import React, { useState, useEffect, useRef, useCallback } from 'react';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';
import { io } from 'socket.io-client';

import { useTopology } from '../../Contexts/TopologyContext';

export default function MininetTerminal() {

  const greeting = "You can interact with the mininet CLI over this terminal.\nEnter 'help' to get a list of available commands!\nThe Ctrl-C interrupt is unavailable here, so enter c or C to interrupt the last command.";
  const { loadedHosts} = useTopology();

  const [terminalLineData, setTerminalLineData] = useState({"old":[]});
  const [currentNode, setCurrentNode] = useState("h1");

  const [socket, setSocket] = useState(null);
  const [messageHistory, setMessageHistory] = useState({"old":[]});

  const terminalLineDataRef = useRef(terminalLineData);
  const messageHistoryRef = useRef(messageHistory);
  const changeTerminalLineDataRef = useRef(setTerminalLineData);
  const changeMessageHistoryRef = useRef(setMessageHistory);

  // TODO: this should get moved to a context, otherwise the terminals clear input when page is left
  function appendLineData(host, newEntry) {

    if ( !(host in terminalLineData) ) {
      console.log("ENTRY: ",newEntry, "for invbalid host: ",host)
      console.log(terminalLineData)
      console.log("--------------------------------")
      return
    }
    console.log("NEW ENTRY",newEntry,terminalLineData,host);

    // Update key host of state dict
    setTerminalLineData({
      ...terminalLineData,
      [host]: [...terminalLineData[host], newEntry]
    });

    // Update key host of state dict
    setMessageHistory({
      ...messageHistory,
      [host]: [...messageHistory[host], newEntry]
    });

  }


  // Update when loaded hosts changes
  useEffect(() => {
    console.log("UPDATING HOST TERMINALS",loadedHosts);

    const updatedData = {};
    const updatedHistory = {};

    loadedHosts.forEach(element => {
      updatedData[element] = [greeting];
      updatedHistory[element] = [greeting];
    });

    setTerminalLineData(updatedData);
    setMessageHistory(updatedHistory);
    
  },[loadedHosts]);

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
  },[]);

  // When data changes, set new handle response function for socket callback
  useEffect(() => {
    if (!(socket === null)) {
      // Unregister any old listener
      socket.removeAllListeners("response");
      // Add the new listener
      // Handle response will have the correct references to the terminalLine and history states
      socket.on('response', handleResponse);
    }
  },[terminalLineData,messageHistory,socket])

  const handleResponse = useCallback((message) => {
    const parsed = JSON.parse(message)
    console.log("RESPONSE",parsed,terminalLineData);

    appendLineData(parsed.name, parsed.data);

  },[terminalLineData,messageHistory]);


  function handleInput(host, text) {
    // Add Input to history and current terminal
    appendLineData(host, "$ " + text);

    const to_send = {
      "target": host,
      "cmd": text};
    
    // Send input to backend
    socket.send(to_send);
  }

  // Main Terminal window
  return (
    <div className="container">
      {
        loadedHosts.map((host,index) => (
          <Terminal name={host} colorMode={ColorMode.Dark} onInput={(text) => handleInput(host, text)}>
            {
            // Add per host if it already exists in the data
            (host in terminalLineData) && terminalLineData[host].map((line, index) => (
              <TerminalOutput key={index}>{line}</TerminalOutput>
          ))}
          </Terminal>
        ))}
    </div>
  )
}