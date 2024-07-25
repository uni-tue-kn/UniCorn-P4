import React, { useState } from 'react';
import axios from 'axios';
import { Box, Stack, Typography, List, ListItem, Button, IconButton, ListItemButton, ListItemText, Divider, Tooltip } from '@mui/material';
import { Table, TableBody, TableRow, TableCell } from '@mui/material';

import { useSwitch } from '../../../Contexts/SwitchContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import EditSwitch from './EditSwitch';

import { returnFullDate } from '../../Helpers/DateHelper';
import { switchInput } from '../../Helpers/InputHelper';

import ListItemIcon from '@mui/material/ListItemIcon';
import Collapse from '@mui/material/Collapse';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import AddLinkOutlinedIcon from '@mui/icons-material/AddLinkOutlined';
import LinkIcon from '@mui/icons-material/Link';
import CircularProgress from '@mui/material/CircularProgress';

function SwitchHistory() {

    const { switches, getSwitches, currentSwitchID, setCurrentSwitchID, historySwitches, getHistorySwitches } = useSwitch();
    const { callSnackbar} = useSnackbar();

    const [loadingID, setLoadingID] = useState(null);

    const [editOpen, setEditOpen] = useState(false);

    const [editData, setEditData] = useState({
        'id': null,
        'config': null
    });


    const deleteHistorySwitch = (event, id) => {
        axios
            .delete("/switches/known", {
                data: {
                    db_id: id
                }
            })
            .then(res => {
                getHistorySwitches();
            })
            .catch(err => {
                console.log(err)
            });
    }

    const editHistorySwitch = (event, id) => {
        const newEditData = { ...editData };
        newEditData['id'] = id;
        const historySwitch = historySwitches.find(config => config.id === id);
        const config = {
            name: historySwitch.name,
            address: historySwitch.address,
            device_id: historySwitch.device_id,
            proto_dump_file: historySwitch.proto_dump_file
        }

        newEditData['config'] = config
        setEditData(newEditData);
        setEditOpen(true);
    }

    const connectHistorySwitch = (event, id) => {
        event.preventDefault();
        setLoadingID(id);
        axios.post("/switches/known", {
            db_id: id
        })
            .then(res => {
                setCurrentSwitchID(res.data);
                getSwitches();
                getHistorySwitches();
                setLoadingID(null);
            })
            .catch(err => {
                callSnackbar("error", err.response.data.error || "There was an error while adding the switch");
                console.log(err);
                setLoadingID(null);
            })
    }

    // Collapsable list logic
    const [expanded, setExpanded] = useState(null);

    const handleChange = (event, panel) => {
        setExpanded(expanded === panel ? false : panel);
    };

    return (
        <Box id='SwitchHistory'>
            <Stack direction='column' spacing={2}>
                <Stack direction='row' spacing={1}>
                    <LinkOffOutlinedIcon sx={{ color: 'darkred' }} />
                    <Typography color='primary' variant='h6'>Known Switches</Typography>
                </Stack>
                {historySwitches.length > 0 ?
                
                <List>
                    {historySwitches.map((switch_config) => (
                        <React.Fragment>
                            <ListItem secondaryAction={
                                <Stack direction='row'>
                                    <Tooltip title='connect switch with controller'>
                                        <IconButton disabled={loadingID === switch_config.id} onClick={(event) => connectHistorySwitch(event, switch_config.id)}>
                                            {loadingID === switch_config.id ? <CircularProgress size={20} /> : <AddLinkOutlinedIcon color='primary' />}
                                        </IconButton>
                                    </Tooltip>
                                    <IconButton onClick={(event) => editHistorySwitch(event, switch_config.id)}>
                                        <EditIcon />
                                    </IconButton>
                                    <IconButton onClick={(event) => deleteHistorySwitch(event, switch_config.id)}>
                                        <DeleteIcon />
                                    </IconButton>
                                </Stack>}>
                                <ListItemButton
                                    onClick={(event) => handleChange(event, 'panel' + switch_config.id)}
                                >
                                    <ListItemIcon>
                                        {expanded === ('panel' + switch_config.id) ? <ExpandLess /> : <ExpandMore />}
                                    </ListItemIcon>
                                    <ListItemText primary={
                                        <Typography >
                                            {switch_config.name}
                                        </Typography>
                                    }
                                    />
                                </ListItemButton>
                            </ListItem>
                            <Collapse in={expanded === ('panel' + switch_config.id)} timeout="auto" unmountOnExit>
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
                                            {/*<TableRow>
                                                <TableCell>Last time connected</TableCell>
                                                <TableCell>{returnFullDate(switch_config.last_connection)}</TableCell>
                                            </TableRow>*/}
                                        </TableBody>
                                    </Table>
                                </Stack>
                            </Collapse>
                            {!(expanded === ('panel' + switch_config.id)) && <Divider variant="inset" component="li" />}
                        </React.Fragment>
                    ))
                    }
                </List>
            :
            <Typography color='error'>There are no known switches to display!</Typography>    
            }
            </Stack>
            {editOpen && <EditSwitch open={editOpen} setOpen={setEditOpen} editConfig={editData['config']} id={editData['id']}></EditSwitch>}
        </Box>
    )
}

export default SwitchHistory


