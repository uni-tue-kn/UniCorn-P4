import React, { useState, useEffect } from 'react';
import axios from 'axios'

import { Button, FormControl, TextField, Box, MenuItem, Checkbox, FormControlLabel} from '@mui/material';
import { useSnackbar } from '../../../Contexts/SnackbarContext';
import { useSwitch } from '../../../Contexts/SwitchContext';

import { useTopology } from '../../../Contexts/TopologyContext';

//import { handleSwitch } from '../SwitchConnections/SwitchDashboard/AddNewSwitch'

export default function TopologySelector() {
    const { callSnackbar } = useSnackbar();
    const { knownTopologies, setCurrentTopologyName, currentTopologyName } = useTopology();

    const { switchesOnline, switches, getSwitches, deleteSwitch, getSwitchesOnline, setCurrentSwitchID, getHistorySwitches} = useSwitch();

    // Set selected topology state based on currently loaded or empty if none are loaded
    const [selectedTopology, setSelectedTopology] = useState(currentTopologyName);
    const [loading, setLoading] = useState(false);
    const [createSwitches, setCreateSwitches] = useState(true);

    function loadTopology() {

        console.log("Selected topology: " + selectedTopology);
        // TODO do something with loading
        setLoading(true);

        // TODO dont hardcode netsim API
        axios
        // Start up the topology in mininet
        .post("http://127.0.0.1:5001/topology/load", {
            topology_file: selectedTopology,
        })
        .then(res => {
            setCurrentTopologyName(selectedTopology);
            getSwitchesOnline();
            callSnackbar("success", "Updated topology to " + selectedTopology);

            const switches_in_topology = Object.keys(res.data.switches);

            // Disconnect switches and optionally connect switches from topology
            let new_switches = [];
            switchesOnline["switches_online"].map((s) => {
                // Assert that the switches from online are contained in the selected topology
                const newSwitchConfig = {
                    name: s.name,
                    address: "127.0.0.1:" + s.grpc_port,
                    device_id: s.dev_id,
                    proto_dump_file: s.name + "_proto.log"
                }                
                if (switches_in_topology.includes(s.name)){
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
            console.log(err);
            setLoading(false);
            callSnackbar("error", err || "There was an error during loading a new topology!" + err);
        });

    }

    function changeTopology(name) {
        if (name !== "") {
            setSelectedTopology(name);
        }
    }

    return (
        <FormControl>
            <Box display="flex" alignment="center">
                <TextField
                    size="small"
                    label="Select Topology"
                    select
                    value={selectedTopology}
                    sx={{ flexGrow: 1, marginRight: "16px" }}
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
                <Button
                    variant="contained"
                    color='primary'
                    type='submit'
                    onClick={loadTopology}
                    sx={{ marginLeft: 'auto' }}
                >Load Topology
                </Button>
            </Box>
        </FormControl>
    )
}