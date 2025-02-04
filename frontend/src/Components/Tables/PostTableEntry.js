import React from 'react';
import { useState } from 'react';
import axios from 'axios';

import { useTable } from '../../Contexts/TableContext';
import { useSnackbar } from '../../Contexts/SnackbarContext';
import { useSwitch } from '../../Contexts/SwitchContext';


import { postEntryInput } from '../Helpers/PostHelper';

import { Button, IconButton } from '@mui/material'
import {Dialog, DialogActions, DialogContent, DialogTitle} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close';

import { encodeNumerics } from '../Helpers/Decoding/DecodingHelper';
import { entryHandler } from '../Helpers/HandleHelper';

function PostTableEntry({ tableName, updateTableEntries, toggleAdding, needsPriority }) {

  const { currentSwitchID } = useSwitch();
  const { tableInfo, decoding } = useTable();
  const { callSnackbar} = useSnackbar();

  //State for new Entries being added
  const [postEntryData, setPostEntryData] = useState({
      table_name: tableName,
      match_fields: {},
      action_name: null,
      action_params: {},
      priority: null
  });

  const handlePost = (event) => {
    event.preventDefault();
    const newPostEntryData = entryHandler(event, postEntryData, tableInfo, tableName);
    console.log(newPostEntryData)
    setPostEntryData(newPostEntryData);
  }

  const submitPost = (event) => {
    event.preventDefault();
    const encoded_entry = encodeNumerics(postEntryData, decoding, tableInfo, tableName);
    axios.post("/tables", {
      switch_id: currentSwitchID,
      entry: JSON.stringify(encoded_entry)
    })
    .then(res => {
      updateTableEntries(tableName);
      toggleAdding();
    })
    .catch(err => {
      callSnackbar("error", err.response?.data?.error || "There was an error while posting the entry");
      console.log(err)
    })
  }

    return (
      <Dialog open maxWidth='md' >
        <DialogTitle>
            Add a new entry
            <IconButton 
              onClick={toggleAdding}
              sx={{
                position: 'absolute',
                right: 8,
                top: 8,
                color: (theme) => theme.palette.grey[500],
              }}
            >
          <CloseIcon />
        </IconButton>
        </DialogTitle>
        <form onSubmit={submitPost}>
        <DialogContent>
          {postEntryInput(tableInfo, tableName, postEntryData, handlePost, needsPriority)}
        </DialogContent>
        <DialogActions>
          <Button variant='outlined' onClick={toggleAdding}>Cancel</Button>
          <Button variant='contained' type="submit">Add Entry</Button>
        </DialogActions>
        </form>
      </Dialog>
    )
}


export default PostTableEntry
