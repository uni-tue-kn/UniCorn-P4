import React from 'react';
import { Paper, Typography, Button } from '@mui/material';
import CloudOffIcon from '@mui/icons-material/CloudOff';

export function MininetOffline() {

    return (
        <Paper
            sx={{
                padding: 5,
                mt: 4,
                maxWidth: 500,
                mx: 'auto',
                textAlign: 'center',
                borderRadius: 3,
                backgroundColor: '#f8d7da',
                color: '#721c24'
            }}
            elevation={3}
        >
            <CloudOffIcon sx={{ fontSize: 60, color: '#721c24' }} />
            <Typography variant="h6" gutterBottom>
                Mininet is currently offline
            </Typography>
            <Typography variant="body1">
                Please check if the docker container is running and try again.
            </Typography>
            <Button
                variant="contained"
                sx={{ mt: 2, backgroundColor: '#d32f2f', '&:hover': { backgroundColor: '#b71c1c' } }}
                onClick={() => window.location.reload()}
            >
                Retry
            </Button>
        </Paper>
    )
}

export function BackendOffline() {

    return (
        <Paper
            sx={{
                padding: 5,
                mt: 4,
                maxWidth: 500,
                mx: 'auto',
                textAlign: 'center',
                borderRadius: 3,
                backgroundColor: '#f8d7da',
                color: '#721c24'
            }}
            elevation={3}
        >
            <CloudOffIcon sx={{ fontSize: 60, color: '#721c24' }} />
            <Typography variant="h6" gutterBottom>
                The backend is currently offline
            </Typography>
            <Typography variant="body1">
                Please check if the docker container is running and try again.
            </Typography>
            <Button
                variant="contained"
                sx={{ mt: 2, backgroundColor: '#d32f2f', '&:hover': { backgroundColor: '#b71c1c' } }}
                onClick={() => window.location.reload()}
            >
                Retry
            </Button>
        </Paper>
    )
}
