import React from 'react'

import { useSwitch } from '../../../Contexts/SwitchContext'

import { Box, Typography, Grid, Paper, Button, Select, MenuItem, FormControl, InputLabel } from '@mui/material';

function MenuLogs() {
    const { logContent, getLogFile, setLimit, limit, updateLog, setUpdateLog } = useSwitch();

    // Toggle refresh state
    const toggleRefresh = () => {
        setUpdateLog(prev => !prev);
    };

    // Handle limit change
    const handleLimitChange = (event) => {
        const newLimit = event.target.value;
        setLimit(newLimit);
        getLogFile(newLimit); // Fetch logs with new limit
    };

    getLogFile();

    return (
        <Box sx={{ flexGrow: 1 }}>
            <Typography variant='h5' gutterBottom>Switch Log File</Typography>
            <Grid container spacing={2} alignItems="center">
                {/* Refresh Button */}
                <Grid item>
                    <Button variant="contained" color={updateLog ? "secondary" : "primary"} onClick={toggleRefresh}>
                        {updateLog ? "Stop Refresh" : "Start Refresh"}
                    </Button>
                </Grid>

                {/* Log Limit Selector */}
                <Grid item>
                    <FormControl>
                        <InputLabel>Limit</InputLabel>
                        <Select value={limit} onChange={handleLimitChange}>
                            <MenuItem value={50}>50</MenuItem>
                            <MenuItem value={100}>100</MenuItem>
                            <MenuItem value={200}>200</MenuItem>
                            <MenuItem value={500}>500</MenuItem>
                        </Select>
                    </FormControl>
                </Grid>
            </Grid>

            <Grid container >
                <Grid item xs={12} xl={10}>
                <Paper sx={{ padding: '16px', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }} elevation={3}>
                        {logContent || 'Loading logs...'}
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    )
}

export default MenuLogs