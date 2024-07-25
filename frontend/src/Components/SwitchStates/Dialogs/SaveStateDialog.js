import React, { useState, useEffect } from 'react'

import axios from 'axios';

import { useInit } from '../../../Contexts/InitContext';

import { Dialog, DialogContent, DialogContentText, DialogActions, DialogTitle, Typography } from '@mui/material'
import { TextField, Button, IconButton } from '@mui/material'

import CloseIcon from '@mui/icons-material/Close';

function SaveStateDialog({ open, setOpen }) {

  const { initializedFiles, updateInitializedFiles } = useInit();

  const [overwrite, setOverwrite] = useState(false);

  const [name, setName] = useState(initializedFiles.state_name);
  useEffect(() => setName(initializedFiles.state_name), [open]);

  const handleNameChange = (event) => {
    event.preventDefault();
    const newName = event.target.value;
    setName(newName);
  }

  const closeDialog = (event) => {
    setName(null);
    setOpen(false);
  }

  const submitDialog = (event, ask_for_overwrite) => {
    submitSave(event, initializedFiles.state_id, name, ask_for_overwrite);
  }

  const submitSave = (event, id, name, ask_for_overwrite) => {
    axios
      .post("/saved", {
        state_id: id,
        name: name,
        ask_for_overwrite: ask_for_overwrite
      })
      .then(res => {
        if (res.data == "overwrite?") {
          setOverwrite(true);
        }
        else {
          setName(null);
          setOverwrite(false);
          closeDialog();
          updateInitializedFiles();
        }
      })
      .catch(err => {
        console.log(err);
      });
  }
  
  return (

    <Dialog open={open} 
    fullWidth
    maxWidth="xs">
      <DialogTitle>
        Save State
        <IconButton
          onClick={(event) => closeDialog(event)}
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
      <DialogContent>
        <DialogContentText>
          Enter a name for the state
        </DialogContentText>
        <TextField
          autoFocus
          margin="dense"
          name="name"
          label="State Name"
          fullWidth
          disabled={overwrite}
          variant="standard"
          defaultValue={initializedFiles != null && initializedFiles.state_name}
          onChange={(event) => handleNameChange(event)}
        />
      </DialogContent>

      {!(overwrite)
        ?
        <DialogActions>
          <Button onClick={(event) => closeDialog(event)}>Cancel</Button>
          <Button onClick={(event) => submitDialog(event, true)}>Save</Button>
        </DialogActions>
        :
        <DialogActions>
          <Typography variant='body1' color='error' align='left'>There is aready a state with that name. <br /> Do you want to overwrite the state?</Typography>
          <Button onClick={(event) => setOverwrite(false)}>No</Button>
          <Button onClick={(event) => submitDialog(event, false)}>Yes</Button>
        </DialogActions>
      }


    </Dialog>

  )
}

export default SaveStateDialog