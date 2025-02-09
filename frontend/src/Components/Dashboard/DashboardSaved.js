import React from 'react';

import SavedList from '../SwitchStates/Saved/SavedList';

import { Box, Stack, Typography } from '@mui/material';

function DashboardSaved() {


    return (
        <Box id='Dashboard Saved'>
            <Stack direction='column' spacing={2}>
                <Typography color='primary.text' variant='h6' gutterBottom>Saved</Typography>
                <SavedList />
            </Stack>
        </Box>
    )
}

export default DashboardSaved