import React, { useState, useEffect } from 'react';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';
import { io } from 'socket.io-client';


export default function MininetTerminal() {

  const [terminalLineData, setTerminalLineData] = useState([
    <TerminalOutput>Welcome to the React Terminal UI Demo!</TerminalOutput>
  ]);

  const [socket, setSocket] = useState(null);
  const [messageHistory, setMessageHistory] = useState([]);

  useEffect(() => {
    // Connect to the Flask-SocketIO server
    const newSocket = io('http://127.0.0.1:5001', {
      transports: ['websocket'],
    });

    // Save the socket instance
    setSocket(newSocket);

    // Handle incoming messages
    newSocket.on('response', (message) => {
      setMessageHistory((prev) => [...prev, message]);
    });

    // Clean up the connection when the component unmounts
    return () => {
      newSocket.close();
    };
  }, []);


  function handleInput(text) {
    console.log("SENDING:",text);
    socket.send(text);
  }

  // Main Terminal window
  return (
    <div className="container">
      <Terminal name='Mininet CLI' colorMode={ColorMode.Dark} onInput={handleInput}>
        {terminalLineData}
      </Terminal>
    </div>
  )
}