import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box, Button, Paper, Tab, Tabs, Typography } from '@mui/material';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import Terminal, { ColorMode, TerminalOutput } from 'react-terminal-ui';
import { useTerminal } from '../../Contexts/TerminalContext';

function TerminalPane({ name, lines, onInput, onInterrupt }) {
  const host = useRef(null), following = useRef(true), previousSize = useRef(null);
  const [paused, setPaused] = useState(false);
  const latest = () => {
    following.current = true; setPaused(false);
    const viewport = host.current?.querySelector('.react-terminal');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  };
  useLayoutEffect(() => {
    const viewport = host.current?.querySelector('.react-terminal');
    if (!viewport) return;
    // A new output chunk can render before the browser dispatches a user's
    // scroll event. Compare against the preceding content height so that it
    // cannot pull a reader back to the bottom during that window.
    const previous = previousSize.current;
    if (following.current && previous && previous.height - previous.visible - viewport.scrollTop > 24) {
      following.current = false; setPaused(true);
    }
    if (following.current) viewport.scrollTop = viewport.scrollHeight;
    previousSize.current = { height: viewport.scrollHeight, visible: viewport.clientHeight };
  }, [lines]);
  return <Box ref={host} sx={{ position: 'relative' }} onScrollCapture={event => {
    const viewport = event.target;
    if (!viewport.classList?.contains('react-terminal')) return;
    const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24;
    following.current = atBottom; setPaused(!atBottom);
  }} onKeyDownCapture={event => {
    if (event.ctrlKey && event.key === 'c') { event.preventDefault(); event.stopPropagation(); onInterrupt(name); }
  }}>
    {paused && <Button size="small" variant="contained" startIcon={<VerticalAlignBottomIcon />} onClick={latest} sx={{ position: 'absolute', top: 8, right: 16, zIndex: 1 }}>Jump to latest output</Button>}
    <Terminal name={name} colorMode={ColorMode.Dark} redBtnCallback={() => onInterrupt(name)} onInput={text => { following.current = true; setPaused(false); onInput(name, text); }}>
      {lines.map((line, index) => <TerminalOutput key={index}>{line}</TerminalOutput>)}
    </Terminal>
  </Box>;
}

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
      <TerminalPane key={selected} name={selected} lines={terminalLineData[selected] || []} onInput={handleInput} onInterrupt={handleInterrupt} />
    </>}
  </Paper>;
}
