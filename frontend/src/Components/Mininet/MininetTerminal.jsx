import React from 'react';
import { Box, Paper, Tab, Tabs, Typography } from '@mui/material';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';
import { useTerminal } from '../../Contexts/TerminalContext';

export default function MininetTerminal() {
  const { terminalTargets, terminalLineData, activeTerminal, setActiveTerminal,
    handleInput, handleInterrupt, connected } = useTerminal();
  const selected = activeTerminal || terminalTargets[0]?.name || null;
  return <Paper sx={{ p: { xs: 2, md: 4 } }} elevation={3}>
    <Typography variant="h6" gutterBottom>Terminals</Typography>
    {terminalTargets.length === 0 ? <Typography color="text.secondary">Deploy a topology to open host and switch terminals.</Typography> : <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {connected ? 'Connected. Output is kept while you switch between pages.' : 'Connecting to the terminal backend…'}
      </Typography>
      <Tabs value={selected || false} onChange={(_event, name) => setActiveTerminal(name)} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        {terminalTargets.map(target => <Tab key={target.name} value={target.name} label={`${target.name} (${target.type})`} />)}
      </Tabs>
      <Box onKeyDownCapture={event => {
        if (event.ctrlKey && event.key === 'c') { event.preventDefault(); event.stopPropagation(); handleInterrupt(selected); }
      }}>
        <Terminal name={selected} colorMode={ColorMode.Dark} redBtnCallback={() => handleInterrupt(selected)} onInput={text => handleInput(selected, text)}>
          {(terminalLineData[selected] || []).map((line, index) => <TerminalOutput key={index}>{line}</TerminalOutput>)}
        </Terminal>
      </Box>
    </>}
  </Paper>;
}
