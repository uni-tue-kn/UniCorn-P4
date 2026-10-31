import React from 'react';
import Box from '@mui/material/Box';
import Toolbar from '@mui/material/Toolbar';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import { BackendOffline } from './Helpers/Offline.jsx';

import { Snackbar, Alert } from '@mui/material';

import Navbar from './Menu/Navbar';

import { useSnackbar } from '../Contexts/SnackbarContext';
import { useAPI } from '../Contexts/APIContext';
import MainRoutes from './Menu/MainRoutes';

function DashboardContent() {

  const { snackbarState, closeSnackbar } = useSnackbar();
  const { backendOnline } = useAPI();

  const handleClose = (event, reason) => {
    if (reason === 'clickaway') {
      return;
    }
    closeSnackbar();
  }

  return (
      <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <Navbar></Navbar>
        <Box
          component="main"
          sx={{
            backgroundColor: (theme) =>
              theme.palette.mode === 'light'
                ? theme.palette.grey[100]
                : theme.palette.grey[900],
            flexGrow: 1,
            minWidth: 0,
            height: '100vh',
            overflow: 'auto',
          }}
        >
          <Toolbar sx={{ minHeight: '136px !important', flexShrink: 0 }} />
          <Container maxWidth="xl" sx={{ mt: 4, mb: 4, pb: 3 }}>
            <Grid>
              {backendOnline ?
                <MainRoutes />
                :
                <BackendOffline/>
              }
            </Grid>
          </Container>
        </Box>
        <Snackbar
          open={snackbarState.open}
          autoHideDuration={5000}
          onClose={handleClose}
          anchorOrigin={{
            vertical: 'top',
            horizontal: 'center'
          }}
        >
          {(snackbarState.severity != null && snackbarState.content != null) &&
            <Alert onClose={handleClose} severity={snackbarState.severity} >
              {snackbarState.content}
            </Alert>
          }
        </Snackbar>
      </Box>
  );
}

export default function MainPage() {
  return <DashboardContent />;
}
