import React, { useEffect, useRef, useState } from 'react';
import { styled } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import MuiDrawer from '@mui/material/Drawer';
import MuiAppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import { Stack, Tooltip, useMediaQuery } from '@mui/material';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import MenuIcon from '@mui/icons-material/Menu';
import { useTheme } from '../../Contexts/ThemeContext';


import { useLocation } from 'react-router-dom';

import MenuItems from './MenuItems';
import SwitchSelect from '../SwitchConnections/SwitchSelect';
import VersionInfo from './VersionInfo';
import NetworkArchive from '../Mininet/NetworkArchive';

import logo from '../../assets/unicorn_p4_logo_cut.png'; // Adjust the path as necessary

// Based on https://github.com/mui/material-ui/tree/v5.11.13/docs/data/material/getting-started/templates/dashboard

const drawerWidth = 240;
const storageKey = 'unicorn.sidebar.v1';
const maxWidth = () => window.innerWidth < 900 ? 480 : Math.max(220, Math.min(480, window.innerWidth - 80));
const clampWidth = width => Math.max(220, Math.min(maxWidth(), width));
function savedSidebar() {
    try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        return { collapsed: saved?.collapsed === true, width: Number.isFinite(saved?.width) ? clampWidth(saved.width) : drawerWidth };
    } catch { return { collapsed: false, width: drawerWidth }; }
}

const AppBar = styled(MuiAppBar)(
    ({ theme }) => ({
        zIndex: theme.zIndex.drawer + 1,
        overflow: 'hidden',
    })
);

const Drawer = styled(MuiDrawer)({
    height: '100vh',
    '& .MuiDrawer-paper': {
        position: 'relative',
        whiteSpace: 'nowrap',
        width: drawerWidth,
        boxSizing: 'border-box',
        height: '100vh',
        overflowY: 'auto',
    },
});

function Navbar() {
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [sidebar, setSidebar] = useState(savedSidebar);
    const desktop = useMediaQuery('(min-width:900px)');
    const drag = useRef(null);
    const width = sidebar.collapsed ? 72 : sidebar.width;
    useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(sidebar)); } catch { /* Storage may be unavailable. */ } }, [sidebar]);
    useEffect(() => {
        const resize = () => setSidebar(previous => ({ ...previous, width: clampWidth(previous.width) }));
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);
    const resizeSidebar = value => setSidebar(previous => ({ ...previous, width: clampWidth(value) }));
    const { darkMode, toggleDarkMode } = useTheme(); // Get dark mode state
    const location = useLocation();
    const hideSidebarRoutes = ['/', '/topology', '/terminals', '/mininet', '/compile', '/switches'];
    const showSidebar = !hideSidebarRoutes.includes(location.pathname);

    return (
        <>
          <CssBaseline />
          <AppBar position="absolute" open={true}>
            <Toolbar sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {/* Left Side: Logo & Title */}
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center', minWidth: 0 }}>
                {showSidebar && <Tooltip title={desktop ? (sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar') : 'Open resource menu'}><IconButton aria-label={desktop ? (sidebar.collapsed ? 'Expand sidebar' : 'Collapse sidebar') : 'Open resource menu'} color="inherit" onClick={() => desktop ? setSidebar(previous => ({ ...previous, collapsed: !previous.collapsed })) : setMobileMenuOpen(true)}><MenuIcon /></IconButton></Tooltip>}
                <Box>
                  <Box component="img" src={logo} alt="UniCorn-P4" sx={{ height: { xs: 44, sm: 60 }, display: 'block' }} />
                </Box>
                <Typography
                  component="h1"
                  variant="h5"
                  color="inherit"
                  noWrap
                  sx={{ flexGrow: 1, display: { xs: 'none', md: 'block' } }}
                  gutterBottom
                >
                  UniCorn-P4: A Universal Control Plane and GUI for P4
                </Typography>
              </Stack>

              {/* Right Side: SwitchSelect and Dark Mode Button */}
              <Stack direction="row" spacing={{ xs: 0, sm: 2 }} sx={{ alignItems: 'center', flexShrink: 0 }}>
                <VersionInfo />
                <NetworkArchive />
                <IconButton aria-label="Toggle color theme" onClick={toggleDarkMode} sx={{ color: 'inherit' }}>
                  {darkMode ? <Brightness7Icon /> : <Brightness4Icon />}
                </IconButton>
              </Stack>
            </Toolbar>
            <SwitchSelect />
          </AppBar>
          {showSidebar ? (
            <><Drawer variant="permanent" open={true} sx={{ display: { xs: 'none', md: 'block' }, flexShrink: 0, width, '& .MuiDrawer-paper': { width, overflowX: 'hidden' } }}>
              <Toolbar
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  px: [1],
                  height: '130px',
                }}
              />
              <Divider />
              <MenuItems collapsed={sidebar.collapsed} onExpand={() => setSidebar(previous => ({ ...previous, collapsed: false }))} />
              {!sidebar.collapsed && <Box role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={220} aria-valuemax={maxWidth()} aria-valuenow={sidebar.width} tabIndex={0}
                onKeyDown={event => {
                    const value = { ArrowLeft: sidebar.width - 16, ArrowRight: sidebar.width + 16, Home: 220, End: maxWidth() }[event.key];
                    if (value !== undefined) { event.preventDefault(); resizeSidebar(value); }
                }}
                onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); drag.current = { x: event.clientX, width: sidebar.width }; event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={event => { if (drag.current) resizeSidebar(drag.current.width + event.clientX - drag.current.x); }}
                onPointerUp={event => { drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                onLostPointerCapture={() => { drag.current = null; }}
                sx={{ position: 'absolute', top: 136, bottom: 0, right: 0, width: 6, cursor: 'col-resize', touchAction: 'none', '&:hover, &:focus-visible': { bgcolor: 'primary.main' } }} />}
            </Drawer>
            <MuiDrawer variant="temporary" open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} sx={{ display: { xs: 'block', md: 'none' }, '& .MuiDrawer-paper': { width: drawerWidth, pt: '136px' } }}>
              <Box onClick={event => { if (event.target.closest('a')) setMobileMenuOpen(false); }}><MenuItems /></Box>
            </MuiDrawer></>
          ) : (
            <Box sx={{ minWidth: 24 }} />
          )}
        </>
      );
    }

export default Navbar
