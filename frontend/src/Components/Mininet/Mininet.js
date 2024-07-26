import React from 'react';
import Topology from './Topology/Topology';
import { Box, Grid, Paper, Typography } from '@mui/material'
import MininetTerminal from './MininetTerminal';


export default function Mininet() {
    return (
        <Box id='Mininet' sx={{ flexGrow: 1 }}>
            <Typography variant='h5' gutterBottom>Mininet Extension</Typography>
            <Grid container spacing={{ xs: 2, lg: 3 }}>
                <Grid item xs={10} lg={12} xl={10} >
                    <Paper sx={{ padding: '32px', height: 600, overflow: 'hidden' }} elevation={3}>
                        <Topology />
                    </Paper>
                </Grid>
                <Grid item xs={10} lg={12} xl={10} >
                        <MininetTerminal></MininetTerminal>
                </Grid>

            </Grid>
        </Box>
    )

}



