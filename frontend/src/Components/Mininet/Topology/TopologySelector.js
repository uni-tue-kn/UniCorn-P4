import React, { useState, useEffect } from 'react';
import axios from 'axios'

import { Button, FormControl, CircularProgress, TextField, Box, MenuItem, Checkbox, FormControlLabel, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import { useSwitch } from '../../../Contexts/SwitchContext';

import { useTopology } from '../../../Contexts/TopologyContext';

import PublishIcon from '@mui/icons-material/Publish';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';

export default function TopologySelector() {
    const { callSnackbar } = useSnackbar();
    const { loadedTopology,knownTopologies, setLoadedHosts, currentTopologyName, getTopologies, getLoadedTopology, setCurrentTopologyName, setLoadedTopology } = useTopology();

    const { switchesOnline, getSwitches, getSwitchesOnline, getHistorySwitches } = useSwitch();

    // Set selected topology state based on currently loaded or empty if none are loaded
    const [selectedTopology, setSelectedTopology] = useState(currentTopologyName);
    const [loading, setLoading] = useState(false);
    const [createSwitches, setCreateSwitches] = useState(true);

    // Confirm dialog for topology clear
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    // Start the emulation of a topology in the mininet container
    function buildSwitchConfigsForTopology(topologySwitches, onlineSwitches) {
        const switchesInTopology = Object.keys(topologySwitches || {});
        let new_switches = [];

        (onlineSwitches || []).forEach((s) => {
            const newSwitchConfig = {
                name: s.name,
                address: "127.0.0.1:" + s.grpc_port,
                device_id: s.dev_id,
                proto_dump_file: s.name + "_proto.log"
            }
            if (switchesInTopology.includes(s.name)) {
                new_switches.push(newSwitchConfig);
                console.log("Create switch " + s.name + " " + s.grpc_port)
            }
        })

        if (new_switches.length !== switchesInTopology.length) {
            let warning_msg = "Not all switches from the topology could be loaded. Try connecting them manually."
            callSnackbar("warning", warning_msg);
            console.log(warning_msg);
        }

        return new_switches;
    }

    function connectSwitchesFromTopology(new_switches) {
        return axios.post("/switches/from_topology", {
            switch_configs: JSON.stringify(new_switches),
            create_switches: createSwitches
        }).then(() => {
            getSwitches();
            getHistorySwitches();
            setLoading(false);
        })
            .catch(err => {
                if (Object.keys(err).includes("response")) {
                    callSnackbar("error", "There was an error while adding the switch: " + err.response.data + ". Try connecting it manually.");
                } else {
                    callSnackbar("error", "There was an error while adding the switch: " + err + ". Try connecting it manually.");
                }
                console.log(err);
                setLoading(false);
            })
    }

    function handleTopologyLoaded(topologyData, showRecoveredMessage = false) {
        getLoadedTopology();
        let hosts = topologyData.hosts || [];
        console.log("HOSTS", hosts);
        setLoadedHosts(hosts);
        getSwitchesOnline();

        if (showRecoveredMessage) {
            callSnackbar("success", "Updated topology to " + selectedTopology + " (recovered after transport error)");
        } else {
            callSnackbar("success", "Updated topology to " + selectedTopology);
        }

        const new_switches = buildSwitchConfigsForTopology(topologyData.switches, topologyData.switches_online);
        return connectSwitchesFromTopology(new_switches);
    }

    async function tryRecoverLoadAfterNetworkError(err) {
        // Axios "Network Error" can happen even when Mininet already completed the
        // topology load. Verify current topology and reconstruct the expected data.
        if (err?.response || err?.message !== "Network Error") {
            return false;
        }

        try {
            const [loadedTopoRes, topoDefRes, switchesOnlineRes] = await Promise.all([
                axios.get("http://127.0.0.1:5001/topology/get"),
                axios.get("/topologies", {
                    params: {
                        name: selectedTopology
                    }
                }),
                axios.get("http://127.0.0.1:5001/switches/online")
            ]);

            if (loadedTopoRes.data?.file_name !== selectedTopology) {
                return false;
            }

            const topoDef = topoDefRes.data?.[selectedTopology];
            if (!topoDef) {
                return false;
            }

            handleTopologyLoaded({
                hosts: topoDef.hosts || [],
                switches: topoDef.switches || {},
                switches_online: switchesOnlineRes.data?.switches_online || []
            }, true);
            return true;
        } catch (recoveryErr) {
            console.log("Topology load recovery failed", recoveryErr);
            return false;
        }
    }

    async function loadTopology() {

        setLoading(true);

        // TODO dont hardcode netsim API
        try {
            const res = await axios
                // Start up the topology in mininet
                .post("http://127.0.0.1:5001/topology/load", {
                    topology_file: selectedTopology,
                }, { timeout: 60000 });

            handleTopologyLoaded(res.data);
        } catch (err) {
            console.log(err);

            const recovered = await tryRecoverLoadAfterNetworkError(err);
            if (recovered) {
                return;
            }

            setLoading(false);
            callSnackbar("error", "There was an error during loading a new topology! '" + err.message + "'" + " Check the log of the mininet docker container!");
        }

    }

    function changeTopology(name) {
        if (name !== "") {
            setSelectedTopology(name);
        }
    }

    const handleClearClick = () => {
        setIsDialogOpen(true);
    }

    const handleClearClose = () => {
        setIsDialogOpen(false);
    };

    const clearTopology = () => {
        setLoading(true);
        axios.delete("/switches/active", {headers: {accept: "application/json"}, data: {}})
            .then((res) => {
                // Destroy mininet topology
                axios.delete("http://127.0.0.1:5001/topology/load", {headers: {accept: "application/json"}, data: {}})
                    .then((res) => {
                        // Update states
                        getSwitches();
                        getHistorySwitches();
                        getSwitchesOnline();
                        setCurrentTopologyName("");
                        setLoadedTopology("");
                        setLoadedHosts([]);
                        handleClearClose();
                        setLoading(false);
                        callSnackbar("success", "Cleared topology");
                    })
                    .catch(err => {
                        if (Object.keys(err).includes("response")) {
                            callSnackbar("error", "There was an error while clearing the topology: " + err.response.data + ".");
                        } else {
                            callSnackbar("error", "There was an error while clearing the topology: " + err + ".");
                        }
                        console.log(err);
                        setLoading(false);
                    })
            })
            .catch(err => {
                if (Object.keys(err).includes("response")) {
                    callSnackbar("error", "There was an error while disconneting the switches: " + err.response.data + ".");
                } else {
                    callSnackbar("error", "There was an error while disconneting the switches: " + err + ".");
                }
                console.log(err);
                setLoading(false);
            })
        console.log('Cleared topology.');
    };

    return (
        <FormControl>
            <Box display="flex" alignment="center">
                <TextField
                    size="small"
                    label="Select Topology"
                    select
                    value={selectedTopology}
                    sx={{ flexGrow: 1, marginRight: "16px" }}
                    onFocus={() => { getTopologies() }}
                    onChange={(event) => { changeTopology(event.target.value) }}>
                    {
                        knownTopologies.map(
                            (topologyName) => (
                                <MenuItem key={topologyName} value={topologyName}>{topologyName}</MenuItem>
                            )
                        )
                    }
                </TextField>
                <FormControlLabel
                    control={
                        <Checkbox
                            checked={createSwitches || ""}
                            onChange={(event) => setCreateSwitches(event.target.checked)}
                            color="primary"
                        />
                    }
                    label="Try to connect switches from topology"
                />
                {
                    // Show loading indicator if topology is loading,
                    // otherwise show load topology button
                    loading ?
                        <CircularProgress />
                        :
                        <Button
                            variant="contained"
                            color='primary'
                            type='submit'
                            startIcon={<PublishIcon />}
                            onClick={loadTopology}
                            sx={{ marginLeft: 'auto' }}
                        >Load Topology
                        </Button>
                }
                <Button
                    variant="contained"
                    type='submit'
                    onClick={handleClearClick}
                    startIcon={<DeleteForeverIcon />}
                    sx={{ backgroundColor: '#800000', marginLeft: '10px', paddingLeft: '10px' }}
                >Clear Topology
                </Button>

                <Dialog
                    open={isDialogOpen}
                    onClose={handleClearClose}
                    aria-labelledby="alert-dialog-title"
                    aria-describedby="alert-dialog-description"
                >
                    <DialogTitle id="alert-dialog-title">{"Confirm Action"}</DialogTitle>
                    <DialogContent>
                        <DialogContentText id="alert-dialog-description">
                            This will clear the topology in Mininet. All switches will be disconnected. Unsaved table entries will be lost. Are you sure you want to proceed?
                        </DialogContentText>
                    </DialogContent>
                    <DialogActions>
                        <Button onClick={handleClearClose} color="primary">
                            Cancel
                        </Button>
                        <Button onClick={clearTopology} color="primary" autoFocus>
                            Yes!
                        </Button>
                    </DialogActions>
                </Dialog>

            </Box>
        </FormControl>
    )
}
