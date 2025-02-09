import React, { useState } from 'react';


import { Box, Stack, Typography, List, ListItem, Button, IconButton, ListItemButton, ListItemText, Divider } from '@mui/material';
import { Table, TableBody, TableRow, TableCell } from '@mui/material';

import AddNewSwitch from './AddNewSwitch';

import { useSwitch } from '../../../Contexts/SwitchContext';

import AddIcon from '@mui/icons-material/Add';
import ListItemIcon from '@mui/material/ListItemIcon';
import Collapse from '@mui/material/Collapse';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import ClearIcon from '@mui/icons-material/Clear';


function ActiveSwitches() {

    const { getSwitchesOnline, getSwitches, switches, currentSwitchID, deleteSwitch } = useSwitch();


    const [open, setOpen] = useState(false);

    const handleAddTab = () => {
        setOpen(true);
    };

    const handleAddTabAndGetSwitchesOnline = () => {
        handleAddTab();
        getSwitchesOnline();
    }

    const handleClose = (event, id) => {
        deleteSwitch(id);
    }

    // Collapsable list logic
    const [expanded, setExpanded] = useState(null);

    const handleChange = (event, panel) => {
        setExpanded(expanded === panel ? false : panel);
    };

    return (
        <Box id='AcitveSwitches'>
            <Stack direction='column' spacing={2}>
                <Stack direction='row' spacing={2} justifyContent='space-between'>
                    <Stack direction='row' spacing={1}>
                        <LinkOutlinedIcon sx={{ color: 'green' }} />
                        <Typography color='primary.text' variant='h6'>Connected Switches</Typography>
                    </Stack>
                    <Button
                        size='small'
                        variant='contained'
                        endIcon={<AddIcon />}
                        onClick={handleAddTabAndGetSwitchesOnline}
                    >
                        New Switch Connection
                    </Button>

                </Stack>
                {
                    switches.length > 0 ?
                        <List>
                            {switches.map((switch_config) => (
                                <React.Fragment>
                                    <ListItem key={switch_config.name} secondaryAction={
                                        <IconButton onClick={(event) => handleClose(event, switch_config.device_id)}>
                                            <ClearIcon />
                                        </IconButton>
                                    }>
                                        <ListItemButton
                                            onClick={(event) => handleChange(event, 'panel' + switch_config.device_id)}
                                        >
                                            <ListItemIcon>
                                                {expanded === ('panel' + switch_config.device_id) ? <ExpandLess /> : <ExpandMore />}
                                            </ListItemIcon>
                                            <ListItemText primary={
                                                <Typography>
                                                    {switch_config.device_id === currentSwitchID ? switch_config.name + " (active)" : switch_config.name } 
                                                </Typography>
                                            }
                                            />
                                        </ListItemButton>
                                    </ListItem>
                                    <Collapse in={expanded === ('panel' + switch_config.device_id)} timeout="auto" unmountOnExit>
                                        <Stack sx={{ pl: 4 }}>
                                            <Table>
                                                <TableBody>
                                                    <TableRow>
                                                        <TableCell>Name</TableCell>
                                                        <TableCell>{switch_config.name}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell>Address</TableCell>
                                                        <TableCell>{switch_config.address}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell>Device ID</TableCell>
                                                        <TableCell>{switch_config.device_id}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell>Proto dump filepath</TableCell>
                                                        <TableCell>{switch_config.proto_dump_file != null ? switch_config.proto_dump_file : "-"}</TableCell>
                                                    </TableRow>
                                                </TableBody>
                                            </Table>
                                        </Stack>
                                    </Collapse>
                                    {!(expanded === ('panel' + switch_config.device_id)) && <Divider variant="inset" component="li" />}
                                </React.Fragment>

                            ))
                            }
                        </List>
                        :
                        <Typography color='error'>No active switches connected!</Typography>
                }
            </Stack>
            <AddNewSwitch open={open} setOpen={setOpen}></AddNewSwitch>
        </Box>
    )

}

export default ActiveSwitches