import React from 'react';
import { useState, useEffect } from 'react'
import axios from 'axios'

import { useSwitch } from '../../Contexts/SwitchContext';
import { useTable } from '../../Contexts/TableContext';
import { useSnackbar } from '../../Contexts/SnackbarContext';

import { editMatchInput, editActionInput, findEntry } from '../Helpers/EditHelper';
import { displayTable } from '../Helpers/DisplayHelper';
import { priorityInput } from '../Helpers/InputHelper';
import { StyledTableRow, StyledTableCell } from '../Helpers/DisplayHelper';
import { encodeNumericsArray } from '../Helpers/Decoding/DecodingHelper';
import { entryHandler } from '../Helpers/HandleHelper';

import { Stack, Button } from '@mui/material'

import DeleteIcon from '@mui/icons-material/Delete';
import CloseIcon from '@mui/icons-material/Close';
import SaveIcon from '@mui/icons-material/Save';

function EditableTable({ tableName, tableEntries, updateTableEntries, filteredEntries, toggleEditing, needsPriority }) {

  //Contexts
  const { currentSwitchID } = useSwitch();
  const { tableInfo, decoding } = useTable();
  const { callSnackbar } = useSnackbar();

  const [editTableData, setEditTableData] = useState();

  //Initialize editTableData
  useEffect(() => {
    const newEditTableData = JSON.parse(JSON.stringify(tableEntries));
    (newEditTableData).map(entry => {
      entry.deleted = false;
    });
    setEditTableData(newEditTableData);
  }, []);


  const handleEdit = (event, id) => {
    event.preventDefault();
    const newEditTableData = [ ...editTableData ];
    findEntry(id, newEditTableData).switch_entry = entryHandler(event, findEntry(id, newEditTableData).switch_entry, tableInfo, tableName);
    (id === errorRow && setErrorRow(null));
    setEditTableData(newEditTableData);
  }

  const handleDelete = (event, id) => {
    event.preventDefault();
    const newEditTableData = [ ...editTableData ];
    //Toggle Delete Status
    findEntry(id, newEditTableData).deleted = !findEntry(id, newEditTableData).deleted
    findEntry(id, newEditTableData).switch_entry = findEntry(id, tableEntries).switch_entry
    setEditTableData(newEditTableData);
  }
  
  const submitEdit = (event) => {
    event.preventDefault();
    const oldEntries = JSON.stringify(encodeNumericsArray(tableEntries, decoding, tableInfo, tableName));
    const newEntries = JSON.stringify(encodeNumericsArray(editTableData, decoding, tableInfo, tableName));
    axios.patch("/tables", {
      switch_id: currentSwitchID,
      old: oldEntries,
      new: newEntries
    })
    .then(res => {
      updateTableEntries(tableName);
      toggleEditing();
    })
    .catch(err => {
      console.log(err);
      callSnackbar("error", err.response?.data?.error || "There was an error while editing the entries");
      setErrorRow(err.response?.data?.id != undefined ? err.response.data.id : null);
      updateTableEntries(tableName);
    })
  }

  const handleCancelClick = (event) => {
    updateTableEntries(tableName);
    toggleEditing();
  }

  

  const editableRow = (entry) => (
    <React.Fragment>
      {findEntry(entry.id, editTableData).deleted ? deletedRow(entry) : undeletedRow(entry)}
    </React.Fragment>

  )

  const [errorRow, setErrorRow] = useState(null);

  const deletedRow = (entry) => {
    return (
      <StyledTableRow sx={{textDecoration: 'line-through'}}>
        <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{editMatchInput(tableInfo, tableName, findEntry(entry.id, editTableData).switch_entry, handleEdit, entry.id, true)}</StyledTableCell>
        <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{editActionInput(tableInfo, tableName, findEntry(entry.id, editTableData).switch_entry, handleEdit, entry.id, true)}</StyledTableCell>
        {needsPriority && <StyledTableCell>{priorityInput(findEntry(entry.id, editTableData).switch_entry, handleEdit, entry.id, true)}</StyledTableCell>}
        <StyledTableCell align='center'>
          <Button variant='outlined' sx={{ backgroundColor: '#cecece'}} color='warning' onClick={(event) => handleDelete(event, entry.id)} endIcon={< DeleteIcon />}>Undo</Button>
        </StyledTableCell>
      </StyledTableRow>
    )
  }

  const undeletedRow = (entry) => {
    return (
      <StyledTableRow className={errorRow === entry.id ? 'error-row' : ''}>
        <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{editMatchInput(tableInfo, tableName, findEntry(entry.id, editTableData).switch_entry, handleEdit, entry.id)}</StyledTableCell>
        <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{editActionInput(tableInfo, tableName, findEntry(entry.id, editTableData).switch_entry, handleEdit, entry.id)}</StyledTableCell>
        {needsPriority && <StyledTableCell>{priorityInput(findEntry(entry.id, editTableData).switch_entry, handleEdit, entry.id)}</StyledTableCell>}
        <StyledTableCell align='center'>
          <Button variant='outlined' sx={{ backgroundColor: '#cecece'}} onClick={(event) => handleDelete(event, entry.id)} endIcon={< DeleteIcon />}>Delete</Button>
        </StyledTableCell>
      </StyledTableRow >
    )
  }

  if (editTableData != undefined) {
    return (
      <Stack spacing={2}>
        {displayTable(editableRow, filteredEntries, needsPriority)}
        <Stack spacing={2} direction='row'>
          <Button variant='outlined' sx={{ backgroundColor: '#cecece'}} name="cancelEdit" endIcon={< CloseIcon />} onClick={(event) => handleCancelClick(event)}>Cancel</Button>
          <Button variant='contained' name="submitEdit" endIcon={< SaveIcon />} onClick={submitEdit}>Save</Button>
        </Stack>
      </Stack>
    )

  }
}



export default EditableTable