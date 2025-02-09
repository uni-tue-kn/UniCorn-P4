import React, { useState } from 'react';
import axios from 'axios';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { useSwitch } from '../../../Contexts/SwitchContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import { switchInput } from '../../Helpers/InputHelper';

function EditSwitch({ open, setOpen, editConfig, id }) {
    const { switchesOnline, getHistorySwitches } = useSwitch();
    const { callSnackbar } = useSnackbar();

    const [switchConfig, setSwitchConfig] = useState(editConfig);

    const handleSwitch = (event) => {
        const newSwitchConfig = { ...switchConfig };

        const configField = event.target.name;
        const configValue = event.target.value;

        if (configField === "device_id") {
            newSwitchConfig[configField] = +configValue;
        }
        else {
            newSwitchConfig[configField] = configValue;
        }

        setSwitchConfig(newSwitchConfig);
    }

    const handleDropdownSwitchSelected = (event) => {
        const newSwitchConfig = { ...switchConfig };

        newSwitchConfig.name = event.target.value.name
        // TODO move address into api
        newSwitchConfig.address = "127.0.0.1:" + event.target.value.grpc_port
        newSwitchConfig.device_id = event.target.value.dev_id
        // TODO move file into api
        newSwitchConfig.proto_dump_file = event.target.value.name + "_proto.log"

        setSwitchConfig(newSwitchConfig);
    }    

    const patchSwitch = (event) => {
        event.preventDefault();
        axios
            .patch("/switches/known", {
                db_id: id,
                switch_config: JSON.stringify(switchConfig)
            })
            .then(res => {
                getHistorySwitches();
                closeEdit(event);
            })
            .catch(err => {
                console.log(err);
            })
    }

    const closeEdit = (event) => {
        event.preventDefault()
        setOpen(false);
    };

    return (
        <Dialog open={open}
            fullWidth
            maxWidth="xs">
            <DialogTitle>
                Edit Switch
                <IconButton
                    onClick={closeEdit}
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
            <form onSubmit={patchSwitch}>
                <DialogContent>
                    {switchInput(switchConfig, switchesOnline, handleSwitch, handleDropdownSwitchSelected)}
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeEdit} sx={{ backgroundColor: '#cecece'}}>Cancel</Button>
                    <Button variant="contained" color="primary" type="submit">Submit Edit</Button>
                </DialogActions>
            </form>
        </Dialog >
    );
}

export default EditSwitch;
