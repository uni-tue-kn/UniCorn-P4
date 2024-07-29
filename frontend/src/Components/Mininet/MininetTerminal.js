import React, { useState, useEffect } from 'react';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';
import { io } from 'socket.io-client';


export default function MininetTerminal() {

  const greeting = "You can interact with the mininet CLI over this terminal.\nEnter 'help' to get a list of available commands!\nThe Ctrl-C interrupt is unavailable here, so enter c or C to interrupt the last command.";


  const [terminalLineData, setTerminalLineData] = useState([greeting]);
  const [currentNode, setCurrentNode] = useState("h1");

  const [socket, setSocket] = useState(null);
  const [messageHistory, setMessageHistory] = useState([greeting]);

  useEffect(() => {

    // Connect to the Flask-SocketIO server
    // TODO: this should be moved to a context component
    const newSocket = io('http://127.0.0.1:5001', {
      transports: ['websocket'],
    });

    // Save the socket instance
    setSocket(newSocket);

    // Handle incoming messages
    newSocket.on('response', handleResponse);

    // Clean up the connection when the component unmounts
    return () => {
      newSocket.close();
    };
  }, []);

  // Change terminal when node is changed
  useEffect(() => {

  },[currentNode]);

  function handleResponse(message) {
    
    const parsed = JSON.parse(message)
    console.log("RESPONSE",parsed);
    // If response message is for curretn terminal
    // Add Message to history and display
    if (parsed.name === currentNode) {
      setMessageHistory(oldArray => [...oldArray,parsed.data]);
      setTerminalLineData(oldArray => [...oldArray,parsed.data]);
    }
    
  }

  function handleInput(text) {
    // Add Input to history and current terminal
    setMessageHistory(oldArray => [...oldArray,"$ " + text]);
    setTerminalLineData(oldArray => [...oldArray,"$ " + text]);

    const to_send = {
      "target": currentNode,
      "cmd": text};
    
    // Send input to backend
    socket.send(to_send);
  }

  // Main Terminal window
  return (
    <div className="container">
      <Terminal name={currentNode} colorMode={ColorMode.Dark} onInput={handleInput}>
        {terminalLineData.map((line, index) => (
          <TerminalOutput key={index}>{line}</TerminalOutput>
        ))}
      </Terminal>
    </div>
  )
}