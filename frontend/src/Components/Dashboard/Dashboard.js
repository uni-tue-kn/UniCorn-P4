import React from 'react';

import Initialization from './Initialization';
import DashboardHistory from './DashboardHistory';
import DashboardSaved from './DashboardSaved';

import { useSwitch } from '../../Contexts/SwitchContext';

import { Box, Grid, Paper, Typography } from '@mui/material'

export default function Dashboard() {
    const { currentSwitchID } = useSwitch();
    return (
        <Box id='Dashboard' sx={{ flexGrow: 1 }}>
            <Typography variant='h5' gutterBottom>Dashboard</Typography>
            {currentSwitchID !== null ?
                <Grid container spacing={{ xs: 2, lg: 3 }}>
                    <Grid item xs={10} lg={6} xl={5} >
                        <Paper sx={{ padding: '32px', height: 350 }} elevation={3}>
                            <Initialization />
                        </Paper>

                    </Grid>
                    <Grid item xs={10} lg={6} xl={5} >
                        <Paper sx={{ padding: '32px', height: 350, overflow: 'auto' }} elevation={3}>
                            <DashboardHistory fullHistory />
                        </Paper>
                    </Grid>
                    <Grid item xs={10} lg={12} xl={10} >
                        <Paper sx={{ padding: '32px', height: 300, overflow: 'auto' }} elevation={3}>
                            <DashboardSaved />
                        </Paper>
                    </Grid>
                </Grid>
                :
                <Grid container spacing={{ xs: 2, lg: 3 }}>
                    <Grid item xs={10} lg={6} xl={5} >
                        <Paper sx={{ padding: '32px' }} elevation={3}>
                            <Typography color='error'>You have to select a current switch connection to perform actions on the dashboard!</Typography>
                        </Paper>
                    </Grid>
                </Grid>
            }
        </Box>
    )



}



