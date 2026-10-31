import React from 'react';
import Topology from './Topology/Topology';
import { Box, Grid, Paper } from '@mui/material';
import { MininetOffline } from '../Helpers/Offline.jsx';

import { useAPI } from '../../Contexts/APIContext';


export default function Mininet() {
    const { mininetOnline } = useAPI();

    return (
        <Box id='Topology' sx={{ flexGrow: 1 }}>
            {mininetOnline ?
                <Grid container spacing={{ xs: 2, lg: 3 }}>
                    <Grid size={{ xs: 12, xl: 10 }} >
                        <Paper sx={{ padding: { xs: 2, md: 4 }, overflow: 'visible' }} elevation={3}>
                            <Topology />
                        </Paper>
                    </Grid>
                </Grid>
                :
                <MininetOffline/>
            }
        </Box>
    )

}
