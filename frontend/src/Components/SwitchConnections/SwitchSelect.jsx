import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, Tab, IconButton, Stack, Divider, Button } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import RouterOutlinedIcon from '@mui/icons-material/RouterOutlined';
import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import CodeIcon from '@mui/icons-material/Code';
import styled from '@emotion/styled';
import AddNewSwitch from './SwitchDashboard/AddNewSwitch';

import { useSwitch } from '../../Contexts/SwitchContext';
import { useAPI } from '../../Contexts/APIContext';

import { Link, useLocation } from 'react-router-dom'

const StyledTab = styled(Tab, { shouldForwardProp: prop => prop !== 'compact' })(({ theme, selected, compact }) => ({
    maxHeight: compact ? 32 : 48,
    minHeight: compact ? 32 : 48,
    color: theme.palette.getContrastText(selected ? theme.palette.secondary.light : theme.palette.primary.light),
    backgroundColor: (selected ? theme.palette.secondary.light : theme.palette.primary.light),
    boxShadow: (selected ? theme.shadows[4] : theme.shadows[0]),
    borderRight: '1px solid',
    borderColor: theme.palette.divider,
    borderRadius: 8,
    textTransform: "none",
    minWidth: compact ? 120 : 150,
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: compact ? 13 : 16,
    padding: compact ? '4px 8px' : undefined,
    '&.Mui-selected': {
      color: theme.palette.getContrastText(theme.palette.secondary.light),
    },
  }));

function SelectSwitch({ compact = false }) {
  const { switches, currentSwitchID, setCurrentSwitchID, deleteSwitch } = useSwitch();
  const { backendOnline } = useAPI();

  const location = useLocation();

  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const selectedTab = currentSwitchID;

  const handleChange = (event, id) => {
    setCurrentSwitchID(id);
    navigate('/dashboard');
  };

  const handleMenu = () => {
    setCurrentSwitchID(null);
  }

  const handleAddTab = () => {
    setOpen(true);
  };

  const handleClose = (event, id) => {
    event.stopPropagation();
    deleteSwitch(id)
  }

  return (
    <>
      <Stack direction='row' spacing={compact ? 0.5 : 1} sx={{ padding: compact ? 0 : '10px', alignItems: compact ? 'center' : undefined, overflowX: 'auto', '& > *': { flexShrink: 0 }, '& > .MuiTabs-root': { minWidth: compact ? 120 : 160, minHeight: compact ? 32 : undefined, flexShrink: 1 }, ...(compact && { '& .MuiButton-root': { minHeight: 32, height: 32, py: 0, px: 1, fontSize: 12 }, '& .MuiButton-startIcon': { mr: 0.5 }, '& .MuiSvgIcon-root': { fontSize: 18 } }) }}>
        <Button startIcon={<HubOutlinedIcon />} sx={{ color: theme => theme.palette.getContrastText(location.pathname === '/topology' ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: (location.pathname === "/topology" ? 'secondary.light' : 'primary.light') }}
          component={Link} to="/topology" onClick={handleMenu} >Topology</Button>
        <Button startIcon={<TerminalOutlinedIcon />} sx={{ color: theme => theme.palette.getContrastText(location.pathname === '/terminals' ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: location.pathname === '/terminals' ? 'secondary.light' : 'primary.light' }}
          component={Link} to="/terminals" onClick={handleMenu}>Terminals</Button>
        <Divider orientation="vertical" flexItem />
        <Button startIcon={<CodeIcon />} sx={{ color: theme => theme.palette.getContrastText(['/editor', '/compile'].includes(location.pathname) ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: (['/editor', '/compile'].includes(location.pathname) ? 'secondary.light' : 'primary.light') }}
          component={Link} to="/editor" onClick={handleMenu} >Editor</Button>
        <Divider orientation="vertical" flexItem />
        <Button startIcon={<LanOutlinedIcon />} sx={{ color: theme => theme.palette.getContrastText(location.pathname === '/' || location.pathname === '/switches' ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: (location.pathname === "/" || location.pathname === "/switches" ? 'secondary.light' : 'primary.light') }}
          component={Link} to="/switches" onClick={handleMenu}>Switch Menu</Button>
        <Divider orientation="vertical" flexItem />
        {backendOnline ?
          <><Tabs
            sx={{ '& .MuiTabs-list': { gap: 1 } }}
            variant="scrollable" scrollButtons="auto" slotProps={{ indicator: { style: { display: 'none' } } }}
            value={selectedTab ?? false} onChange={handleChange}
          >
            {switches?.map((switchConfig) => (
              <StyledTab compact={compact} aria-label={switchConfig.name} icon={<RouterOutlinedIcon />} iconPosition="start" value={switchConfig.device_id} selected={selectedTab === switchConfig.device_id} key={switchConfig.device_id} label={<div sx={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ marginRight: compact ? 12 : 50 }}>
                  {switchConfig.name}
                </span>
                <IconButton component="span" role="button" tabIndex={0} aria-label={`Disconnect ${switchConfig.name}`} color="inherit" size="small" onClick={(event) => handleClose(event, switchConfig.device_id)}>
                  <CloseIcon fontSize="small" sx={{ color: 'inherit' }} />
                </IconButton>
              </div>} />
            ))}

          </Tabs><IconButton aria-label="Connect switch" color="inherit" onClick={handleAddTab}>
              <AddIcon />
            </IconButton></>
          : null}
      </Stack>
      {backendOnline ?
        <AddNewSwitch open={open} setOpen={setOpen}></AddNewSwitch>
        :
        null}
    </>
  )
}

export default SelectSwitch;
