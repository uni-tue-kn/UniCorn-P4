import React from 'react';
import { useState } from 'react'

import { useTable } from '../../Contexts/TableContext';
import { useSnackbar } from '../../Contexts/SnackbarContext';
import { useSwitch } from '../../Contexts/SwitchContext';

import { displayMatchKeys, displayTable, displayActionParams, displayActionData, needsPriority } from '../Helpers/DisplayHelper';
import { editActionInput, editMatchInput, findEntry } from '../Helpers/EditHelper';
import { StyledTableRow, StyledTableCell } from '../Helpers/DisplayHelper';
import { encodeNumerics } from '../Helpers/Decoding/DecodingHelper';
import { entryHandler } from '../Helpers/HandleHelper';

import { Typography, Button } from '@mui/material'
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import CloseIcon from '@mui/icons-material/Close';
import SaveIcon from '@mui/icons-material/Save';

import axios from 'axios'
import { Stack } from '@mui/system';
import { priorityInput } from '../Helpers/InputHelper';



function ReadableTable({ tableName, tableEntries, updateTableEntries, filteredEntries, toggleInlineEditing, needsPriority }) {

    const { currentSwitchID } = useSwitch();
    const { tableInfo, decoding } = useTable();
    const { callSnackbar} = useSnackbar();

    const initialEditEntryData = {
        id: null,
        oldEntry: null,
        newEntry: null
    };

    const [editEntryData, setEditEntryData] = useState(initialEditEntryData);
    const handleEditClick = (event, id) => {
        const switch_entry = findEntry(id, tableEntries).switch_entry;
        const newEditEntryData = {
            id: id,
            oldEntry: JSON.parse(JSON.stringify(switch_entry)),
            newEntry: switch_entry
        };
        setEditEntryData(newEditEntryData);
        toggleInlineEditing();
    }

    const handleCancelClick = (event) => {
        resetEditEntryData();
        toggleInlineEditing();
        updateTableEntries(tableName);
    }

    const resetEditEntryData = () => {
        setEditEntryData(initialEditEntryData);
    }

    const handleEdit = (event) => {
        event.preventDefault();
        const newEditEntryData = { ...editEntryData };
        newEditEntryData.newEntry = entryHandler(event, newEditEntryData.newEntry, tableInfo, tableName);
        setEditEntryData(newEditEntryData);
    }

    const submitEdit = (event) => {
        event.preventDefault();
        const oldEntry = JSON.stringify(encodeNumerics(editEntryData.oldEntry, decoding, tableInfo, tableName));
        const newEntry = JSON.stringify(encodeNumerics(editEntryData.newEntry, decoding, tableInfo, tableName));
        if (oldEntry !== newEntry) {
            axios.patch("/tables", {
                switch_id: currentSwitchID,
                old: oldEntry,
                new: newEntry
            })
                .then(res => {
                    updateTableEntries(tableName);
                })
                .catch(err => {
                    console.log(err);
                    callSnackbar("error", err.response?.data?.error || "There was an error while editing the entry");
                    updateTableEntries(tableName);
                })
        }
        resetEditEntryData();
        toggleInlineEditing();
    }

    const submitDelete = (event, id) => {
        const switch_entry = encodeNumerics(findEntry(id, tableEntries).switch_entry, decoding, tableInfo, tableName);
        axios.delete("/tables", {
            data: {
                switch_id: currentSwitchID,
                entry: JSON.stringify(switch_entry)
            }
        })
            .then(res => {
                updateTableEntries(tableName);
            })
            .catch(err => {
                callSnackbar("error", err.response?.data?.error || "There was an error while deleting the entry");
                console.log(err)
            });
    }

    const readableRow = (entry) => (
        editEntryData.id == entry.id ? editableRow(entry) : readOnlyRow(entry)
    )

    const editableRow = (entry) => (
        <StyledTableRow>
            <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{editMatchInput(tableInfo, tableName, editEntryData.newEntry, handleEdit, entry.id)}</StyledTableCell>
            <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{editActionInput(tableInfo, tableName, editEntryData.newEntry, handleEdit, entry.id)}</StyledTableCell>
            {needsPriority && <StyledTableCell>{priorityInput(editEntryData.newEntry, handleEdit, entry.id)}</StyledTableCell>}
            <StyledTableCell align='center'>
                <Stack
                    direction="column"
                    justifyContent="center"
                    alignItems="center"
                    spacing={1}
                >
                    <Button variant='outlined' name='cancel' endIcon={< CloseIcon />} size='small' sx={{ width: 100 }} onClick={handleCancelClick}>Cancel</Button>
                    <Button variant='contained' name='save' endIcon={< SaveIcon />} size='small' sx={{ width: 100 }} type="submit">Save</Button>
                </Stack>
            </StyledTableCell>
        </StyledTableRow >
    )

    const readOnlyRow = (entry) => {
        return (
            <StyledTableRow>
                <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{displayMatchKeys(entry, tableInfo, tableName)}</StyledTableCell>
                <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{displayActionData(entry)}</StyledTableCell>
                {needsPriority && <StyledTableCell>{entry.switch_entry.priority}</StyledTableCell>}
                <StyledTableCell align='center'>
                    <Stack
                        direction="column"
                        justifyContent="center"
                        alignItems="center"
                        spacing={1}
                    >
                        <Button
                            variant='outlined' name='edit_entry'
                            endIcon={< EditIcon />} size='small' sx={{ width: 100 }}
                            onClick={(event) => handleEditClick(event, entry.id)}
                        >
                            Edit
                        </Button>
                        <Button variant='outlined' name='delete_entry'
                            endIcon={< DeleteIcon />} size='small' sx={{ width: 100 }}
                            onClick={(event) => submitDelete(event, entry.id)}
                        >
                            Delete
                        </Button>
                    </Stack>
                </StyledTableCell>
            </StyledTableRow>
        )
    }

    if (tableEntries.length > 0) {
        return (
            <form onSubmit={submitEdit}>
                {displayTable(readableRow, filteredEntries, needsPriority)}
            </form>
        )
    }
    else {
        return (
            <Typography variant='body1' color='error'>The table is empty. You can add an entry above</Typography>
        )
    }
}

export default ReadableTable

