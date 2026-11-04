import React, { useState } from 'react';
import axios from 'axios';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CircularProgress from '@mui/material/CircularProgress';


import { useSwitch } from '../../../Contexts/SwitchContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import { switchInput, validatedSwitchConfig } from '../../Helpers/InputHelper';


function AddNewSwitch({ open, setOpen }) {
    const { switches = [], switchesOnline, getSwitches, setCurrentSwitchID, getHistorySwitches} = useSwitch();
    const { callSnackbar } = useSnackbar();

    const [loading, setLoading] = useState(false);

     const initalConfig = {
        target: 'bmv2',
        target_options: {},
        name: null,
        address: null,
        device_id: null,
        proto_dump_file: null,
        register_adapter_enabled: false,
        register_thrift_host: '',
        register_thrift_port: 9090
    }

    const [switchConfig, setSwitchConfig] = useState(initalConfig);
    const usedIDs = new Set(switches.map(switchConnection => switchConnection.device_id));
    let nextSwitchID = 0;
    while (usedIDs.has(nextSwitchID)) nextSwitchID++;
    const effectiveConfig = { ...switchConfig, device_id: switchConfig.device_id ?? nextSwitchID };

    const handleSwitch = (event) => {
        const newSwitchConfig = { ...switchConfig };

        const configField = event.target.name;
        const configValue = event.target.value;

        if (configField === 'target') {
            newSwitchConfig.target = configValue;
            newSwitchConfig.target_options = configValue === 'tofino' ? { runtime_device_id: 0, pipe_id: 0, client_id: 0 } : {};
            if (configValue === 'tofino') Object.assign(newSwitchConfig, { register_adapter_enabled: false, register_thrift_host: null, register_thrift_port: null });
            else Object.assign(newSwitchConfig, { register_adapter_enabled: false, register_thrift_host: '', register_thrift_port: 9090 });
        }
        else if (configField.startsWith('target_options.')) {
            newSwitchConfig.target_options = { ...newSwitchConfig.target_options, [configField.slice('target_options.'.length)]: event.target.type === 'checkbox' ? event.target.checked : configValue === '' ? '' : Number(configValue) };
        }
        else if (configField === 'register_adapter_enabled') {
            newSwitchConfig[configField] = event.target.checked;
        }
        else if (configField === "device_id" || configField === 'register_thrift_port') {
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
        newSwitchConfig.address = event.target.value.address || "127.0.0.1:" + event.target.value.grpc_port
        newSwitchConfig.device_id = event.target.value.dev_id
        // TODO move file into api
        newSwitchConfig.proto_dump_file = event.target.value.name + "_proto.log"
        newSwitchConfig.register_adapter_enabled = false;
        newSwitchConfig.register_thrift_host = event.target.value.thrift_port ? '127.0.0.1' : '';
        newSwitchConfig.register_thrift_port = event.target.value.thrift_port ?? 9090;

        newSwitchConfig.target = event.target.value.target || 'bmv2';
        newSwitchConfig.target_options = event.target.value.target_options || (newSwitchConfig.target === 'tofino' ? { runtime_device_id: 0, pipe_id: 0, client_id: 0 } : {});
        if (newSwitchConfig.target === 'tofino') Object.assign(newSwitchConfig, { register_thrift_host: null, register_thrift_port: null });
        setSwitchConfig(newSwitchConfig);
    }    

    const postSwitch = (event) => {
        event.preventDefault();
        let configuration;
        try { configuration = validatedSwitchConfig(effectiveConfig); }
        catch (error) { callSnackbar('error', error.message); return; }
        setLoading(true);
        axios.post("/switches/active", {
            switch_config: JSON.stringify(configuration)
        })
            .then(res => {
                getSwitches();
                getHistorySwitches();
                setCurrentSwitchID(configuration.device_id);
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
                    {switchInput(effectiveConfig, switchesOnline, handleSwitch, handleDropdownSwitchSelected)}
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeAdd} variant="outlined">Cancel</Button>
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
