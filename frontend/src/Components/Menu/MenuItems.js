import React, { useEffect } from 'react';
import { useState } from 'react'
import { useSwitch } from '../../Contexts/SwitchContext';
import { useTable } from '../../Contexts/TableContext';

import { List, ListItemButton, ListItemIcon, ListItemText } from '@mui/material';
import { Collapse, Divider } from '@mui/material';

import DashboardIcon from '@mui/icons-material/Dashboard';
import TableRowsIcon from '@mui/icons-material/TableRows';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import GradeIcon from '@mui/icons-material/Grade';
import HistoryIcon from '@mui/icons-material/History';

import { Link as RouterLink, useLocation } from 'react-router-dom'

function MenuItems() {

  const location = useLocation();
  

  const { currentSwitchID } = useSwitch();
  const { tableInfo } = useTable();

  const [open, setOpen] = useState(false);

  const handleClick = () => {
    setOpen(!open);
  };

  //Based on https://mui.com/material-ui/guides/routing/
  const Link = React.forwardRef(function Link(itemProps, ref) {
    return <RouterLink ref={ref} {...itemProps} role={undefined} />;
  });

  function ListItemLink(props) {
    const { icon, primary, to, sx } = props;
    return (
      <li>
        <ListItemButton
          component={Link}
          to={to}
          selected={location.pathname === to}
          disabled={currentSwitchID === null}
          sx={sx ? sx : null}>
          {icon ? <ListItemIcon>{icon}</ListItemIcon> : null}
          <ListItemText primary={primary} />
        </ListItemButton>
      </li>
    );
  }

  const tableSelection = () => {
    if (tableInfo != undefined) {
      return (
        Object.entries(tableInfo).map(([table_name, table_data]) => (
          <ListItemLink
            sx={{ pl: 5 }}
            to={'/tables/' + table_name}
            primary={table_name} >
          </ListItemLink>
        ))
      )
    }
  }

  return (
    <List component="nav">
      <ListItemLink
        to='/dashboard'
        icon={<DashboardIcon />}
        primary="Dashboard"
      />
      <ListItemButton onClick={handleClick} disabled={currentSwitchID === null || tableInfo === null}>
        <ListItemIcon>
          <TableRowsIcon />
        </ListItemIcon>
        <ListItemText primary="Tables" />
        {open ? <ExpandLess /> : <ExpandMore />}
      </ListItemButton>
      <Collapse in={open} timeout="auto" unmountOnExit>
        <List component="div" disablePadding>
          {tableSelection()}
        </List>
      </Collapse>
      <Divider />
      <ListItemLink
        to='/history'
        icon={<HistoryIcon />}
        primary="History"
      />
      <ListItemLink
        to='/saved'
        icon={<GradeIcon />}
        primary="Saved"
      />
    </List>

  )
}

export default MenuItems


