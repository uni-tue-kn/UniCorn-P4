import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, IconButton, Typography, Stack, MenuItem, Divider } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CircularProgress from '@mui/material/CircularProgress';

import { useSwitch } from '../../Contexts/SwitchContext';
import { useSnackbar } from '../../Contexts/SnackbarContext';
import { switchInput } from '../Helpers/InputHelper';

function AddSwitch({ open, setOpen }) {
    const { switchesOnline, getSwitches, setCurrentSwitchID, historySwitches, getHistorySwitches } = useSwitch();
    const { callSnackbar } = useSnackbar();

    const [historySwitchID, setHistorySwitchID] = useState(null);

    const [loading, setLoading] = useState(false);

    const getHistoryConfig = (id) => {
        const historySwitch = historySwitches.find(config => config.id === id);
        const config = {
            name: historySwitch.name,
            address: historySwitch.address,
            device_id: historySwitch.device_id,
            proto_dump_file: historySwitch.proto_dump_file
        }
        return config;
    }

    const handleHistorySwitch = (event) => {
        const id = event.target.value;
        setHistorySwitchID(id);
        const config = getHistoryConfig(id);
        setSwitchConfig(config);
    }

const initialSwitchConfig = {
    name: "",
    address: "",
    device_id: "",
    proto_dump_file: ""
};

const [switchConfig, setSwitchConfig] = useState(initialSwitchConfig);

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

    console.log(event);

    newSwitchConfig.name = event.target.value.name
    // TODO move address into api
    newSwitchConfig.address = "127.0.0.1:" + event.target.value.grpc_port
    newSwitchConfig.device_id = event.target.value.dev_id
    // TODO move file into api
    newSwitchConfig.proto_dump_file = event.target.value.name + "_proto.log"

    setSwitchConfig(newSwitchConfig);
}    

const postSwitchBehaviour = (event) => {
    if (historySwitchID != null) {
        const old_config = getHistoryConfig(historySwitchID);
        if (JSON.stringify(old_config) == JSON.stringify(switchConfig)) {
            connectHistorySwitch(event, historySwitchID);
        }
        else {
            postSwitch(event);
        }
    }
    else {
        postSwitch(event);
    }
}

const connectHistorySwitch = (event, id) => {
    event.preventDefault();
    setLoading(true);
    axios.post("/switches/known", {
        db_id: id
    })
        .then(res => {
            setCurrentSwitchID(res.data);
            getSwitches();
            getHistorySwitches();
            closeAdd(event)
        })
        .catch(err => {
            callSnackbar("error", err.response.data.error || "There was an error while adding the switch");
            console.log(err);
            setLoading(false);
        })
}

const postSwitch = (event) => {
    event.preventDefault();
    setLoading(true);
    if (switchConfig.proto_dump_file === "") {
        switchConfig.proto_dump_file = null;
    }
    axios.post("/switches/active", {
        switch_config: JSON.stringify(switchConfig)
    })
        .then(res => {
            setCurrentSwitchID(switchConfig.device_id);
            getSwitches();
            getHistorySwitches();
            closeAdd(event);
        })
        .catch(err => {
            callSnackbar("error", err.response.data.error || "There was an error while adding the switch");
            console.log(err);
            setLoading(false);
        })
}

const closeAdd = (event) => {
    event.preventDefault();
    setSwitchConfig(initialSwitchConfig);
    setHistorySwitchID(null);
    setLoading(false);
    setOpen(false);
};

return (
    <Dialog open={open}
        fullWidth
        maxWidth="xs">
        <DialogTitle>
            Add Switch
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
        <form onSubmit={postSwitchBehaviour}>
            <DialogContent>
                <Stack direction='column' spacing={2}>
                    <TextField
                        select
                        label='Connect a Known Switch'
                        value={historySwitchID}
                        name='history_switch_id'
                        onChange={(event) => handleHistorySwitch(event)}
                    >
                        {
                            historySwitches.length > 0 ?
                                historySwitches.map((switch_config) => (
                                    <MenuItem value={switch_config.id}>{switch_config.name}</MenuItem>
                                ))
                                :
                                <MenuItem value={null} disabled>No known switches available!</MenuItem>
                        }
                    </TextField>
                    <Divider></Divider>
                    {switchInput(switchConfig, switchesOnline, handleSwitch, handleDropdownSwitchSelected)}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={closeAdd}>Cancel</Button>
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

export default AddSwitch;
