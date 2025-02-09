import React, { useState } from 'react';
import axios from 'axios';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CircularProgress from '@mui/material/CircularProgress';


import { useSwitch } from '../../../Contexts/SwitchContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import { switchInput } from '../../Helpers/InputHelper';


function AddNewSwitch({ open, setOpen }) {
    const { switchesOnline, getSwitches, setCurrentSwitchID, getHistorySwitches} = useSwitch();
    const { callSnackbar } = useSnackbar();

    const [loading, setLoading] = useState(false);

     const initalConfig = {
        name: null,
        address: null,
        device_id: null,
        proto_dump_file: null
    }

    const [switchConfig, setSwitchConfig] = useState(initalConfig);

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

    const postSwitch = (event) => {
        event.preventDefault();
        setLoading(true);
        axios.post("/switches/active", {
            switch_config: JSON.stringify(switchConfig)
        })
            .then(res => {
                getSwitches();
                getHistorySwitches();
                setCurrentSwitchID(switchConfig.device_id);
                closeAdd(event);
            })
            .catch(err => {
                callSnackbar("error", err.response?.data?.error || "There was an error while adding the switch");
                console.log(err);
                setLoading(false);
            })
    }

    const closeAdd = (event) => {
        event.preventDefault();
        setLoading(false);
        setSwitchConfig(initalConfig);
        setOpen(false); 
    };

    return (
        <Dialog open={open}
            fullWidth
            maxWidth="xs">
            <DialogTitle>
                Add New Switch
                <IconButton
                    onClick={closeAdd}
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
            <form onSubmit={postSwitch}>
                <DialogContent>
                    {switchInput(switchConfig, switchesOnline, handleSwitch, handleDropdownSwitchSelected)}
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeAdd} sx={{ backgroundColor: '#cecece'}}>Cancel</Button>
                    {loading ? 
                    <IconButton disabled>
                        <CircularProgress size={20} /> 
                    </IconButton>
                    :                   
                    <Button variant="contained" color="primary" type="submit">Add Switch</Button>
                    }
                </DialogActions>
            </form>
        </Dialog >
    );
}

export default AddNewSwitch;
