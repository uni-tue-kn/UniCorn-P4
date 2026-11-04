import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { useSwitch } from '../../../Contexts/SwitchContext';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import { switchInput, validatedSwitchConfig } from '../../Helpers/InputHelper';

function EditSwitch({ open, setOpen, editConfig, id }) {
    const { switchesOnline, getHistorySwitches } = useSwitch();
    const { callSnackbar } = useSnackbar();

    const [switchConfig, setSwitchConfig] = useState(editConfig);
    useEffect(() => { if (open) setSwitchConfig(editConfig); }, [open, editConfig]);

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

    const patchSwitch = (event) => {
        event.preventDefault();
        let configuration;
        try { configuration = validatedSwitchConfig(switchConfig); }
        catch (error) { callSnackbar('error', error.message); return; }
        axios
            .patch("/switches/known", {
                db_id: id,
                switch_config: JSON.stringify(configuration)
            })
            .then(res => {
                getHistorySwitches();
                closeEdit(event);
            })
            .catch(err => {
                callSnackbar('error', err.response?.data?.error || err.message);
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
                    <Button onClick={closeEdit} variant="outlined">Cancel</Button>
                    <Button variant="contained" color="primary" type="submit">Submit Edit</Button>
                </DialogActions>
            </form>
        </Dialog >
    );
}

export default EditSwitch;
