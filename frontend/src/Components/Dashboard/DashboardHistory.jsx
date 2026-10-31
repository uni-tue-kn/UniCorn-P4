import React from 'react';

import HistoryList from '../SwitchStates/History/HistoryList';

import { Box, Stack, Typography } from '@mui/material';

function DashboardHistory() {


    return (
        <Box id='Dashboard History'>
            <Stack direction='column' spacing={2}>
                <Typography color='primary.text' variant='h6' gutterBottom>History</Typography>
                <HistoryList fullHistory={false} />
            </Stack>
        </Box>
    )
}

export default DashboardHistory