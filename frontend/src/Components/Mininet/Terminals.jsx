import React from 'react';
import { Box } from '@mui/material';
import { useAPI } from '../../Contexts/APIContext';
import { MininetOffline } from '../Helpers/Offline';
import MininetTerminal from './MininetTerminal';

export default function Terminals() {
  const { mininetOnline } = useAPI();
  return <Box sx={{ flexGrow: 1 }}>{mininetOnline ? <MininetTerminal /> : <MininetOffline />}</Box>;
}
