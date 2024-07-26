import React, { useState, useEffect }from 'react';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';


export default function MininetTerminal() {
  const [terminalLineData, setTerminalLineData] = useState([
    <TerminalOutput>Welcome to the React Terminal UI Demo!</TerminalOutput>
  ]);


  function handleInput(text) {
    console.log(text);
  }

  // Main Terminal window
  return (
    <div className="container">
      <Terminal name='Mininet CLI' colorMode={ ColorMode.Dark }  onInput={handleInput}>
        { terminalLineData }
      </Terminal>
    </div>
  )
}