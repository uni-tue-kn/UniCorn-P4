import React, { useState } from 'react';
import { Box, Collapse, Divider, List, ListItemButton, ListItemIcon, ListItemText, Tooltip } from '@mui/material';
import { alpha } from '@mui/material/styles';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import TableChartOutlined from '@mui/icons-material/TableChartOutlined';
import BarChartOutlined from '@mui/icons-material/BarChartOutlined';
import MemoryOutlined from '@mui/icons-material/MemoryOutlined';
import SpeedOutlined from '@mui/icons-material/SpeedOutlined';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import HubOutlined from '@mui/icons-material/HubOutlined';
import NotificationsActiveOutlined from '@mui/icons-material/NotificationsActiveOutlined';
import ViewStreamOutlined from '@mui/icons-material/ViewStreamOutlined';
import TerminalOutlined from '@mui/icons-material/TerminalOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import BookmarkBorderOutlined from '@mui/icons-material/BookmarkBorderOutlined';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { Link, useLocation } from 'react-router-dom';
import { useSwitch } from '../../Contexts/SwitchContext';
import { useInit } from '../../Contexts/InitContext';

function NavIcon({ icon: Icon, active, collapsed }) {
  return <ListItemIcon sx={{ minWidth: collapsed ? 0 : 42 }}><Box sx={theme => ({ width: 30, height: 30, borderRadius: 1.5,
    display: 'grid', placeItems: 'center', color: active ? 'primary.main' : 'text.secondary',
    backgroundColor: alpha(theme.palette.primary.main, active ? 0.14 : 0.04) })}><Icon sx={{ fontSize: 20 }} /></Box></ListItemIcon>;
}

function ResourceGroup({ title, collection, path, disabled, icon, collapsed, onExpand }) {
  const location = useLocation();
  const active = location.pathname.startsWith(`/${path}/`);
  const [open, setOpen] = useState(active);
  return <>
    <Tooltip title={collapsed ? title : ''} placement="right"><span><ListItemButton aria-label={title} onClick={() => { if (collapsed) { onExpand?.(); setOpen(true); } else setOpen(value => !value); }} disabled={disabled || !Object.keys(collection || {}).length} sx={{ borderRadius: 1.5, px: collapsed ? 0.75 : 2, justifyContent: collapsed ? 'center' : 'flex-start' }}>
      <NavIcon icon={icon} active={active} collapsed={collapsed} />{!collapsed && <><ListItemText primary={title} />{open ? <ExpandLess /> : <ExpandMore />}</>}
    </ListItemButton></span></Tooltip>
    <Collapse in={open && !collapsed} timeout="auto" unmountOnExit><List component="div" disablePadding>
      {Object.keys(collection || {}).map(name => <ListItemButton key={name} component={Link} to={`/${path}/${name}`} selected={location.pathname === `/${path}/${name}`} disabled={disabled} sx={{ pl: 4, whiteSpace: 'normal', overflowWrap: 'anywhere' }}><ListItemText primary={name} /></ListItemButton>)}
    </List></Collapse>
  </>;
}

export default function MenuItems({ collapsed = false, onExpand }) {
  const { currentSwitchID } = useSwitch();
  const { initializedFiles } = useInit();
  const location = useLocation();
  const disabled = currentSwitchID == null;
  function link(title, path, Icon) {
    return <Tooltip key={path} title={collapsed ? title : ''} placement="right"><span><ListItemButton aria-label={title} component={Link} to={path} disabled={disabled} selected={location.pathname === path} sx={{ borderRadius: 1.5, px: collapsed ? 0.75 : 2, justifyContent: collapsed ? 'center' : 'flex-start' }}><NavIcon icon={Icon} active={location.pathname === path} collapsed={collapsed} />{!collapsed && <ListItemText primary={title} />}</ListItemButton></span></Tooltip>;
  }
  return <List component="nav" aria-label="Switch resources" sx={{ px: 1 }}>
    {link('Dashboard', '/dashboard', DashboardOutlined)}
    {[['Tables', 'table_info', 'tables', TableChartOutlined], ['Counters', 'counters', 'counters', BarChartOutlined], ['Registers', 'registers', 'registers', MemoryOutlined], ['Meters', 'meters', 'meters', SpeedOutlined]].map(([title, field, path, icon]) => <ResourceGroup key={field} title={title} icon={icon} collection={initializedFiles?.[field]} path={path} disabled={disabled} collapsed={collapsed} onExpand={onExpand} />)}
    {[['Mirrors', '/mirrors', ContentCopyOutlined], ['Multicast', '/multicast-groups', HubOutlined], ['Digests', '/digests', NotificationsActiveOutlined], ['Queues', '/queues', ViewStreamOutlined]].map(([title, path, icon]) => link(title, path, icon))}
    <Divider sx={{ my: 1 }} />
    {[['Logs', TerminalOutlined], ['History', HistoryOutlined], ['Saved', BookmarkBorderOutlined]].map(([title, icon]) => link(title, `/${title.toLowerCase()}`, icon))}
  </List>;
}
