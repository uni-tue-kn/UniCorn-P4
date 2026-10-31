import { Stack, Typography } from '@mui/material'
import React from 'react'

function NotFound() {
    return (
        <Stack direction='column' spacing={2}>
            <Typography variant='h5' gutterBottom>Not Found</Typography>
            <Typography color='error'>The page you requested could not be found!</Typography>
        </Stack>
    )
}

export default NotFound