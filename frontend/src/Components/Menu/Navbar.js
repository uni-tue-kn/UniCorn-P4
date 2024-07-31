import React from 'react';
import { styled, createTheme, ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import MuiDrawer from '@mui/material/Drawer';
import MuiAppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import { Stack } from '@mui/material';
import Box from '@mui/material/Box';


import MenuItems from './MenuItems';
import SwitchSelect from '../SwitchConnections/SwitchSelect';

import logo from '../../assets/unicorn_p4_logo_cut.png'; // Adjust the path as necessary

// Based on https://github.com/mui/material-ui/tree/v5.11.13/docs/data/material/getting-started/templates/dashboard

function Navbar() {
    const drawerWidth = 240;

    const AppBar = styled(MuiAppBar)(
        ({ theme }) => ({
            zIndex: theme.zIndex.drawer + 1
        })
    );
    
    const Drawer = styled(MuiDrawer)({
        '& .MuiDrawer-paper': {
          position: 'relative',
          whiteSpace: 'nowrap',
          width: drawerWidth,
          boxSizing: 'border-box',
        },
      });

    return (
        <>
            <CssBaseline />
            <AppBar position="absolute" open={true}>
            <Toolbar>
                <Box sx={{ width: '100%' }}>
                <Stack direction="row" alignItems="center" spacing={2}>
                    <Box>
                    <img src={logo} alt="UniCorn-P4" style={{ height: '60px' }} />
                    </Box>                        
                    <Typography
                    component="h1"
                    variant="h5"
                    color="inherit"
                    noWrap
                    sx={{ flexGrow: 1 }}
                    gutterBottom
                    >
                    UniCorn-P4: A Universal Control Plane and GUI for P4
                    </Typography>
                </Stack>
                <SwitchSelect />
                </Box>
      </Toolbar>
            </AppBar>
            <Drawer variant="permanent" open={true}>
                <Toolbar
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        px: [1],
                        height: '130px', 
                    }}
                >
                </Toolbar>
                <Divider />

                <MenuItems />
            </Drawer>
        </>
    )
}

export default Navbar