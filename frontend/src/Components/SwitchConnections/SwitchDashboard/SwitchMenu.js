import React from 'react'

import ActiveSwitches from './ActiveSwitches'
import SwitchHistory from './SwitchHistory'
import { Box, Grid, Paper, Typography } from '@mui/material'

function SwitchMenu() {
  return (
    <Box id='SwitchMenu' sx={{ flexGrow: 1 }}>
                <Typography variant='h5' gutterBottom>Switches</Typography>
                <Grid container spacing={{ xs: 2, lg: 3 }}>
                    <Grid item xs={10} lg={6} xl={5} >
                        <Paper sx={{ padding: '32px', height: 350,  overflow: 'auto' }} elevation={3}>
                            <ActiveSwitches />
                        </Paper>

                    </Grid>
                    <Grid item xs={10} lg={6} xl={5} >
                        <Paper sx={{ padding: '32px', height: 350, overflow: 'auto' }} elevation={3}>
                            <SwitchHistory />
                        </Paper>
                    </Grid>
                </Grid>
            </Box>
  )
}

export default SwitchMenu