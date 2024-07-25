import React from 'react'
import HistoryList from './HistoryList'

import { Box, Typography, Grid, Paper } from '@mui/material'

import { useSwitch } from '../../../Contexts/SwitchContext'

function MenuHistory() {
    const { currentSwitchID } = useSwitch();
    return (
        <Box sx={{ flexGrow: 1 }}>
            <Typography variant='h5' gutterBottom>History States</Typography>
            <Grid container >
                <Grid item xs={12} xl={10}>
                    <Paper sx={{ padding: '32px' }} elevation={3}>
                        {currentSwitchID !== null ?
                            <HistoryList fullHistory={true} />
                            :
                            <Typography color='error'>You have to select a current switch connection to see its history!</Typography>
                    }
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    )
}

export default MenuHistory