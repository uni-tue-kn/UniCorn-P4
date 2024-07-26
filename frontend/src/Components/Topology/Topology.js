import React, { useState } from 'react';
import TopologySelector from './TopologySelector';
import { Tabs, Tab, IconButton, Stack, Divider, Typography, Button, FormControl, TextField, Box, MenuItem} from '@mui/material';
import TopologyRenderer from './TopologyRenderer';

export default function Topology() {

    return(
        <Stack direction='column' spacing={2}>
                <Typography color='primary' variant='h6'>Saved Topologies</Typography>
                <TopologySelector></TopologySelector>
                    <TopologyRenderer></TopologyRenderer>
            </Stack>
        
    )
}