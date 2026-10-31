import React from 'react';

import { Box, Stack, Typography } from '@mui/material';

function SwitchSaved() {


    return (
        <Box id='SwitchSaved'>
            <Stack direction='column' spacing={2}>
                <Typography color='primary' variant='h6'>Saved Topologies</Typography>
                <Typography color='warning.light'>To be followed...</Typography>
            </Stack>
        </Box>
    )
}

export default SwitchSaved