import React, { useState, useEffect } from 'react';

import { useInit } from '../../../Contexts/InitContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';

import TablePreviewDialog from '../Dialogs/TablePreviewDialog';

import { returnFullDate } from '../../Helpers/DateHelper';
import { displayFile } from '../../Helpers/DisplayHelper';

import axios from 'axios';
import { Box, TextField, Typography, Button, Stack, Divider, Tooltip } from '@mui/material'

import { Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material'

import { List, ListItem, ListItemText, ListItemButton, IconButton } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';

import ListItemIcon from '@mui/material/ListItemIcon';
import Collapse from '@mui/material/Collapse';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import VisibilityIcon from '@mui/icons-material/Visibility';


function SavedList() {

    const { initializedFiles, initialize } = useInit();
    const { callSnackbar } = useSnackbar();

    // Logic for interacting with the api
    const [savedStates, setSavedStates] = useState();
    
    const updateSavedStates = () => {
        axios
            .get("/saved")
            .then(res => {
                setSavedStates(res.data);
            })
            .catch(err => {
                callSnackbar("error", "Failed to load saved states")
                console.log(err);
            });
    }

    const unsaveState = (event, id) => {
        axios
            .delete("/saved", {
                data: {
                    state_id: id
                }
            })
            .then(res => {
                updateSavedStates();
            })
            .catch(err => {
                callSnackbar("error", "Failed to delete saved state")
                console.log(err);
            });
    }

    const submitEdit = (event, id, old_name) => {
        if (old_name != editName) {
            axios
            .patch("/saved", {
                saved_state_id: id,
                name: editName
            })
            .then(res => {
                updateSavedStates();
            })
            .catch(err => {
                callSnackbar("error", (err.response?.data?.error || "Failed to edit saved state"));
                console.log(err);
            });
        }
        setEditing(false);
    }

    useEffect(updateSavedStates, [initializedFiles]);


    // Logic for editing the name inside the list
    const [editing, setEditing] = useState(false);
    const [editName, setEditName] = useState(null);

    const handleClick = (event, name) => {
        setEditing(!editing);
        setEditName(name);
    }

    const handleNameChange = (event) => {
        event.preventDefault();
        const newEditName = event.target.value;
        setEditName(newEditName);
    }

    // State for declaring if the table preview dialog should be visible
    // -> Tuple with the table entries [0] and the decoding [1] 
    const [tablePreview, setTablePreview] = useState(null);

    const editTablePreview = (event, entries, decoding, table_info) => {
        setTablePreview({
            "entries": entries,
            "decoding": decoding,
            "table_info": table_info
        });
    }

    // Collapsable list logic
    const [expanded, setExpanded] = useState(null);

    const handleChange = (event, panel) => {
        setExpanded(expanded === panel ? false : panel);
    };

    if (savedStates != undefined) {
        return (
            <Box id='SavedList'>
                {savedStates.length > 0 ?
                    <List>
                        {savedStates.map((state) => (
                            <React.Fragment>
                                <ListItem secondaryAction={
                                    <IconButton onClick={(event) => unsaveState(event, state.id)}>
                                        <DeleteIcon />
                                    </IconButton>}>
                                    <ListItemButton
                                        onClick={(event) => handleChange(event, 'panel' + state.id)}
                                    >
                                        <ListItemIcon>
                                            {expanded === ('panel' + state.id) ? <ExpandLess /> : <ExpandMore />}
                                        </ListItemIcon>
                                        <ListItemText primary={
                                            <Typography >
                                                {state.name}
                                                {initializedFiles != null && initializedFiles.state_id == state.id && "(currently initialized)"}
                                            </Typography>
                                        }
                                        />
                                    </ListItemButton>
                                </ListItem>
                                <Collapse in={expanded === ('panel' + state.id)} timeout="auto" unmountOnExit>
                                    <Stack sx={{ pl: 4 }}>
                                        <Table>
                                            <TableHead>
                                                <TableRow>
                                                    <TableCell>Name</TableCell>
                                                    <TableCell>p4 info file</TableCell>
                                                    <TableCell>bmv2 file</TableCell>
                                                    <TableCell>Last initialization</TableCell>
                                                    <TableCell>Actions</TableCell>
                                                </TableRow>
                                            </TableHead>
                                            <TableBody>
                                                <TableRow>
                                                    <TableCell>
                                                        {editing ?
                                                            <React.Fragment>
                                                                <TextField
                                                                    autoFocus
                                                                    margin="none"
                                                                    name="name"
                                                                    defaultValue={state.name}
                                                                    variant="standard"
                                                                    size='small'
                                                                    sx={{ width: '150px' }}
                                                                    onChange={(event) => handleNameChange(event)}
                                                                />
                                                                <IconButton onClick={(event) => handleClick(event, null)}>
                                                                    <CloseIcon />
                                                                </IconButton>
                                                                <IconButton onClick={(event) => submitEdit(event, state.id, state.name)}>
                                                                    <CheckIcon />
                                                                </IconButton>
                                                            </React.Fragment>

                                                            :
                                                            <React.Fragment>
                                                                {state.name}
                                                                <IconButton onClick={(event) => handleClick(event, state.name)}>
                                                                    <EditIcon />
                                                                </IconButton>
                                                            </React.Fragment>
                                                        }
                                                    </TableCell>
                                                    <TableCell>{displayFile(state.p4_info_file)}</TableCell>
                                                    <TableCell>{displayFile(state.bmv2_file)}</TableCell>
                                                    <TableCell>{returnFullDate(state.last_init)}</TableCell>
                                                    <TableCell>
                                                        <Tooltip title="table preview">
                                                            <IconButton onClick={(event) => editTablePreview(event, state.table_entries, state.decoding, state.table_info)}>
                                                                <VisibilityIcon color='primary' />
                                                            </IconButton>
                                                        </Tooltip>
                                                        <Button
                                                            disabled={initializedFiles != null && initializedFiles.state_id == state.id}
                                                            size='small' variant='contained'
                                                            onClick={(event) => initialize(event, state.p4_info_file, state.bmv2_file, false, state.id)}
                                                        >
                                                            Re-Initialize state
                                                        </Button>
                                                    </TableCell>


                                                </TableRow>
                                            </TableBody>
                                        </Table>
                                    </Stack>

                                </Collapse>
                                {!(expanded === ('panel' + state.id)) && <Divider variant="inset" component="li" />}
                            </React.Fragment>
                        ))}
                    </List>
                    :
                    <Typography color='error' variant='body1'>You have not saved any states!</Typography>
                }
                {tablePreview != null && <TablePreviewDialog tablePreview={tablePreview} setTablePreview={setTablePreview} />}
            </Box>
        )
    }
    else {
        <Typography color='error' variant='body1'>Could not load saved states</Typography>
    }
}

export default SavedList