import React from 'react'
import SavedList from './SavedList'

import { Box, Typography, Grid, Paper} from '@mui/material'

function MenuSaved() {
    return (
        <Box sx={{ flexGrow: 1 }}>
            <Typography variant='h5' gutterBottom>Saved States</Typography>
            <Grid container >
                <Grid item xs={12} xl={10}>
                    <Paper sx={{ padding: '32px' }} elevation={3}>
                        <SavedList />
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    )
}

export default MenuSaved