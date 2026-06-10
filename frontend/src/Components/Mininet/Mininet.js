import React from 'react';
import Topology from './Topology/Topology';
import { Box, Grid, Paper } from '@mui/material';
import MininetTerminal from './MininetTerminal';
import { MininetOffline } from '../Helpers/Offline.js';

import { useAPI } from '../../Contexts/APIContext';


export default function Mininet() {
    const { mininetOnline } = useAPI();

    return (
        <Box id='Mininet' sx={{ flexGrow: 1 }}>
            {mininetOnline ?
                <Grid container spacing={{ xs: 2, lg: 3 }}>
                    <Grid item xs={10} lg={12} xl={10} >
                        <Paper sx={{ padding: '32px', overflow: 'visible' }} elevation={3}>
                            <Topology />
                        </Paper>
                    </Grid>
                    <Grid item xs={10} lg={12} xl={10} >
                        <MininetTerminal></MininetTerminal>
                    </Grid>
                </Grid>
                :
                <MininetOffline/>
            }
        </Box>
    )

}
