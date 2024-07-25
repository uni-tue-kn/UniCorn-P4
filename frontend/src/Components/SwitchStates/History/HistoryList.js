import React, { useState, useEffect } from 'react';

import { useInit } from '../../../Contexts/InitContext';
import { useSwitch } from '../../../Contexts/SwitchContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';

import TablePreviewDialog from '../Dialogs/TablePreviewDialog';

import { returnMonthDay, returnTime, returnFullDate } from '../../Helpers/DateHelper';
import { displayFile } from '../../Helpers/DisplayHelper';
import axios from 'axios';

import { TextField, FormControl, Typography, Button, Stack, MenuItem, Divider, Paper, Table, TableHead, TableBody, TableCell, Grid, Box, Tooltip, TableRow } from '@mui/material'

import { List, ListItem, ListItemText, ListItemButton, IconButton, ListSubheader } from '@mui/material'
import DeleteIcon from '@mui/icons-material/Delete';

import ListItemIcon from '@mui/material/ListItemIcon';
import Collapse from '@mui/material/Collapse';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import VisibilityIcon from '@mui/icons-material/Visibility';


function HistoryList({ fullHistory }) {

    const { initializedFiles, initialize } = useInit();
    const { callSnackbar } = useSnackbar();
    const { currentSwitchID } = useSwitch();
    
    // Logic for interacting with the api
    const [tableHistory, setTableHistory] = useState();

    const updateTableHistory = () => {
        axios
            .get("/history", {
                params: {
                    switch_id: currentSwitchID
                }
            })
            .then(res => {
                setTableHistory(res.data);
            })
            .catch(err => {
                callSnackbar("error", "Failed to load history")
                console.log(err);
            });
    }

    const deleteHistoryState = (event, id) => {
        axios
            .delete("/history", {
                data: {
                    state_id: id
                }
            })
            .then(res => {
                updateTableHistory();
            })
            .catch(err => {
                callSnackbar("error", "Failed to delete history state")
                console.log(err);
            });
    }

    useEffect(updateTableHistory, [initializedFiles]);

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

    if (tableHistory != undefined) {
        let date = null;
        let dateHeader = null;
        let mapHistory = tableHistory;
        if (!fullHistory) {
            // Only the latest 5 States
            mapHistory = tableHistory.slice(0, 5);
        }
        return (
            <Box id='HistoryList'>
                {tableHistory.length > 0 ?
                    <List>
                        {mapHistory.map((state) => {
                            let currentDate = returnMonthDay(state.last_init);
                            if (currentDate === date) {
                                dateHeader = <></>;
                            } else {
                                dateHeader = <ListSubheader disableSticky>{currentDate}</ListSubheader>;
                                date = currentDate
                            }
                            return (
                                <React.Fragment>
                                    {dateHeader}
                                    <ListItem secondaryAction={
                                        <IconButton onClick={(event) => deleteHistoryState(event, state.id)}>
                                            <DeleteIcon />
                                        </IconButton>}>
                                        <ListItemButton
                                            onClick={(event) => handleChange(event, 'panel' + state.id)}

                                        >
                                            <ListItemIcon>
                                                {expanded === ('panel' + state.id) ? <ExpandLess /> : <ExpandMore />}
                                            </ListItemIcon>
                                            <ListItemText primary={
                                                <div style={{ display: "flex" }}>
                                                    <Typography sx={{ color: 'grey' }}>{returnTime(state.last_init)}</Typography>
                                                    <Typography>&nbsp; &nbsp;</Typography>
                                                    <Typography >{displayFile(state.p4_info_file)} {initializedFiles != null && initializedFiles.state_id == state.id && "(currently initialized)"}</Typography>
                                                </div>}
                                            />

                                        </ListItemButton>
                                    </ListItem>
                                    <Collapse in={expanded === ('panel' + state.id)} timeout="auto" unmountOnExit>
                                        <Stack sx={{ pl: 4 }} direction='column'>
                                            <Table>
                                                <TableBody>
                                                    <TableRow>
                                                        <TableCell>p4 info file</TableCell>
                                                        <TableCell>{displayFile(state.p4_info_file)}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell>bmv2 file</TableCell>
                                                        <TableCell>{displayFile(state.bmv2_file)}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell>Created</TableCell>
                                                        <TableCell>{returnFullDate(state.date_created)}</TableCell>
                                                    </TableRow>
                                                    <TableRow>
                                                        <TableCell>Actions</TableCell>
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
                            )
                        })}
                    </List>
                    :
                    <Typography variant='body1' color='error'>The history is empty!</Typography>
                }
                {tablePreview != null && <TablePreviewDialog tablePreview={tablePreview} setTablePreview={setTablePreview} />}
            </Box>
        )
    }
    else {
        return (
            <Typography variant='body1' color='error'>Could not load history</Typography>
        )
    }

}

export default HistoryList