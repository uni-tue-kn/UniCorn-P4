import React, { useState, useEffect } from 'react';
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

function SelectSwitch() {
  const { switches, currentSwitchID, setCurrentSwitchID, deleteSwitch } = useSwitch();
  const { backendOnline } = useAPI();

  const location = useLocation();

  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  // False ensures that no tab is selected at first
  const [selectedTab, setSelectedTab] = useState(false);

  useEffect(() => {
    setSelectedTab(currentSwitchID);
  }, [currentSwitchID]);

  const handleChange = (event, id) => {
    setCurrentSwitchID(id);
    setSelectedTab(id);
    navigate('/dashboard');
  };

  const handleMenu = () => {
    setSelectedTab(false);
    setCurrentSwitchID(null);
  }

  const handleAddTab = () => {
    setOpen(true);
  };

  const handleClose = (event, id) => {
    event.stopPropagation();
    deleteSwitch(id)
  }

  const StyledTab = styled(Tab)(({ theme, selected }) => ({
    maxHeight: 48,
    minHeight: 48,
    color: theme.palette.getContrastText(selected ? theme.palette.secondary.light : theme.palette.primary.light),
    backgroundColor: (selected ? theme.palette.secondary.light : theme.palette.primary.light),
    boxShadow: (selected ? theme.shadows[4] : theme.shadows[0]),
    borderRight: '1px solid',
    borderColor: theme.palette.divider,
    borderRadius: 8,
    textTransform: "none",
    minWidth: '150px',
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: 16,
    '&.Mui-selected': {
      color: theme.palette.getContrastText(theme.palette.secondary.light),
    },
  }));

  return (
    <>
      <Stack direction='row' spacing={1} sx={{ padding: '10px', overflowX: 'auto', '& > *': { flexShrink: 0 }, '& > .MuiTabs-root': { minWidth: 160, flexShrink: 1 } }}>
        <Button startIcon={<HubOutlinedIcon />} sx={{ color: theme => theme.palette.getContrastText(location.pathname === '/topology' ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: (location.pathname === "/topology" ? 'secondary.light' : 'primary.light') }}
          component={Link} to="/topology" onClick={handleMenu} >Topology</Button>
        <Button startIcon={<TerminalOutlinedIcon />} sx={{ color: theme => theme.palette.getContrastText(location.pathname === '/terminals' ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: location.pathname === '/terminals' ? 'secondary.light' : 'primary.light' }}
          component={Link} to="/terminals" onClick={handleMenu}>Terminals</Button>
        <Divider orientation="vertical" flexItem />
        <Button startIcon={<CodeIcon />} sx={{ color: theme => theme.palette.getContrastText(location.pathname === '/compile' ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: (location.pathname === "/compile" ? 'secondary.light' : 'primary.light') }}
          component={Link} to="/compile" onClick={handleMenu} >P4 Compile</Button>
        <Divider orientation="vertical" flexItem />
        <Button startIcon={<LanOutlinedIcon />} sx={{ color: theme => theme.palette.getContrastText(location.pathname === '/' || location.pathname === '/switches' ? theme.palette.secondary.light : theme.palette.primary.light), backgroundColor: (location.pathname === "/" || location.pathname === "/switches" ? 'secondary.light' : 'primary.light') }}
          component={Link} to="/switches" onClick={handleMenu}>Switch Menu</Button>
        <Divider orientation="vertical" flexItem />
        {backendOnline ?
          <><Tabs
            variant="scrollable" scrollButtons="auto" slotProps={{ indicator: { style: { display: 'none' } } }}
            value={selectedTab ?? false} onChange={handleChange}
          >
            {switches?.map((switchConfig) => (
              <StyledTab aria-label={switchConfig.name} icon={<RouterOutlinedIcon />} iconPosition="start" value={switchConfig.device_id} selected={selectedTab === switchConfig.device_id} key={switchConfig.device_id} label={<div sx={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ marginRight: '50px' }}>
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
