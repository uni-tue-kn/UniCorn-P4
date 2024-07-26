import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Tabs, Tab, IconButton, Stack, Divider, Typography, Button } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import RouterOutlinedIcon from '@mui/icons-material/RouterOutlined';
import styled from '@emotion/styled';
import AddSwitch from './AddSwitch';

import { useSwitch } from '../../Contexts/SwitchContext';

import { Link, useLocation } from 'react-router-dom'

function SelectSwitch() {
  const { switches, currentSwitchID, setCurrentSwitchID, deleteSwitch } = useSwitch();

  const location = useLocation();

  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  // False ensures that no tab is selected at first
  const [selectedTab, setSelectedTab] = useState(false);

  const handleChange = (event, id) => {
    setCurrentSwitchID(id);
    setSelectedTab(id);
    navigate('/dashboard');
  };

  const handleMenu = () => {
    setSelectedTab(false);
  }

  const handleAddTab = () => {
    setOpen(true);
  };

  const handleClose = (event, id) => {
    deleteSwitch(id)
  }

  const StyledTab = styled(Tab)(({ theme, selected }) => ({
    maxHeight: 48,
    minHeight: 48,
    color: 'white',
    backgroundColor: (selected ? theme.palette.secondary.main : theme.palette.primary.light),
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
  }));

  return (
    <>
      <Stack direction='row' spacing={1} sx={{padding: 10 + "px"}}>
        <Button startIcon={<LanOutlinedIcon />} sx={{  color: 'white', backgroundColor: (location.pathname === "/" || location.pathname === "/switches" ? 'secondary.light' : 'primary.light') }}
          component={Link} to="/switches" onClick={handleMenu}>Switch Menu</Button>
        <Divider orientation="vertical" flexItem />
        <Tabs
          variant="scrollable" scrollButtons="auto" TabIndicatorProps={{ style: { display: 'none' } }}
          value={selectedTab} onChange={handleChange}
        >
          {switches?.map((switchConfig) => (
            <StyledTab icon={<RouterOutlinedIcon />} iconPosition="start" value={switchConfig.device_id} selected={selectedTab === switchConfig.device_id} key={switchConfig.device_id} label={
              <div sx={{ display: 'flex', alignItems: 'center' }}>
                <span style={{ marginRight: '50px' }}>
                  {switchConfig.name}
                </span>
                <IconButton size="small" onClick={(event) => handleClose(event, switchConfig.device_id)}>
                  <CloseIcon fontSize="small" sx={{ color: 'white' }} />
                </IconButton>
              </div>
            } />
          ))}

        </Tabs>
        <IconButton onClick={handleAddTab}>
          <AddIcon sx={{ color: 'white' }} />
        </IconButton>
      </Stack>
      <AddSwitch open={open} setOpen={setOpen}></AddSwitch>
    </>
  )
}

export default SelectSwitch;
