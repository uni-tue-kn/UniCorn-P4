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
    function loadTopology() {

        setLoading(true);

        // TODO dont hardcode netsim API
        axios
            // Start up the topology in mininet
            .post("http://127.0.0.1:5001/topology/load", {
                topology_file: selectedTopology,
            })
            .then(res => {
                getLoadedTopology();
                // Store list of loaded hosts
                let hosts = res.data.hosts;
                console.log("HOSTS", hosts);
                setLoadedHosts(hosts);
                getSwitchesOnline();
                callSnackbar("success", "Updated topology to " + currentTopologyName);

                const switches_in_topology = Object.keys(res.data.switches);
                // Disconnect switches and optionally connect switches from topology
                let new_switches = [];
                switchesOnline["switches_online"].forEach((s) => {
                    // Assert that the switches from online are contained in the selected topology
                    const newSwitchConfig = {
                        name: s.name,
                        address: "127.0.0.1:" + s.grpc_port,
                        device_id: s.dev_id,
                        proto_dump_file: s.name + "_proto.log"
                    }
                    if (switches_in_topology.includes(s.name)) {
                        new_switches.push(newSwitchConfig);
                        console.log("Create switch " + s.name + " " + s.grpc_port)
                    }
                })



                if (new_switches.length !== switches_in_topology.length) {
                    let warning_msg = "Not all switches from the topology could be loaded. Try connecting them manually."
                    callSnackbar("warning", warning_msg);
                    console.log(warning_msg);
                }

                // Disconnects all active switch connections and optionally connects the new ones from the topology
                axios.post("/switches/from_topology", {
                    switch_configs: JSON.stringify(new_switches),
                    create_switches: createSwitches
                }).then(res => {
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
            })
            .catch(err => {
                setLoading(false);
                console.log(err);
                callSnackbar("error", "There was an error during loading a new topology! '" + err.message + "'" + " Check the log of the mininet docker container!");
            });

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