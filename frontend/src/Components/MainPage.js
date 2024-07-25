import React from 'react';
import { styled, createTheme, ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import MuiDrawer from '@mui/material/Drawer';
import Box from '@mui/material/Box';
import MuiAppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import List from '@mui/material/List';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Badge from '@mui/material/Badge';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Link from '@mui/material/Link';

import { Snackbar, Alert } from '@mui/material';


import Navbar from './Menu/Navbar';

import { useSnackbar } from '../Contexts/SnackbarContext';

import MainRoutes from './Menu/MainRoutes';

function Copyright(props) {
  return (
    <Typography variant="body2" color="text.secondary" align="center" {...props}>
      {'Copyright © 2024'}
      <Link color="inherit" href="https://mui.com/">
        Your Website
      </Link>{' '}
      {new Date().getFullYear()}
      {'.'}
    </Typography>
  );
}


//const mdTheme = createTheme();
const mdTheme = createTheme({
  palette: {
    primary: {
      main: '#1d103c', // Change this to your desired primary color
    },
    secondary: {
      main: '#00887c', // Change this to your desired secondary color
    },
  },
});

function DashboardContent() {

  const { snackbarState, closeSnackbar } = useSnackbar();

  const handleClose = (event, reason) => {
    if (reason === 'clickaway') {
      return;
    }
    closeSnackbar();
  }

  return (
    <ThemeProvider theme={mdTheme}>
      <Box sx={{ display: 'flex' }}>
        <Navbar></Navbar>
        <Box
          component="main"
          sx={{
            backgroundColor: (theme) =>
              theme.palette.mode === 'light'
                ? theme.palette.grey[100]
                : theme.palette.grey[900],
            flexGrow: 1,
            height: '100vh',
            overflow: 'auto',
          }}
        >
          <Toolbar sx={{ height: '100px', }} />
          <Container maxWidth="l" sx={{ mt: 4, mb: 4, pb: 3 }}>
            <Grid>
              <MainRoutes />
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
          {
            (
              snackbarState.severity != null
              && snackbarState.content != null
            ) ?
              <Alert onClose={handleClose} severity={snackbarState.severity} >
                {snackbarState.content}
              </Alert>
              :
              <></>
          }
        </Snackbar>

      </Box>
    </ThemeProvider>
  );
}

export default function MainPage() {
  return <DashboardContent />;
}