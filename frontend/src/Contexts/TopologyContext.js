import React, { createContext, useContext, useEffect, useState } from 'react';
import axios from 'axios';

const TopologyContext = createContext(null);

export function useTopology() {
    return useContext(TopologyContext);
}

export function TopologyProvider({ children }) {

    // State that saves list of known Topologies
    const [knownTopologies, setKnownTopologies] = useState([]);
    const [loadedTopology, setLoadedTopology] = useState("");
    const [loadedHosts, setLoadedHosts] = useState([]);
    const [loadedSwitches, setLoadedSwitches] = useState([]);

    // Topology that is currently loaded in Mininet
    const [currentTopologyName, setCurrentTopologyName] = useState("");

    // Request topology data from backend and store state
    function loadTopologyByName() {
        if (currentTopologyName === "") {
            setLoadedTopology("");
            setLoadedHosts([]);
            setLoadedSwitches([]);
            return;
        }

        getLoadedTopology();
    }

    // Get topology that is currently loaded in Mininet and store it in state
    function getLoadedTopology() {
        axios
            .get("http://127.0.0.1:5001/topology/get", {
            })
            .then(res => {
                const topology = res.data;
                // Store name for new topology
                if (topology["file_name"] === null) {
                    setCurrentTopologyName("");
                    setLoadedTopology("");
                    setLoadedHosts([]);
                    setLoadedSwitches([]);
                } else {
                    setCurrentTopologyName(topology["file_name"]);
                    setLoadedTopology(topology);
                    setLoadedHosts(topology.hosts || []);
                    setLoadedSwitches(Object.keys(topology.switches || {}));
                }
            })
            .catch(err => {
                //callSnackbar("error", "Failed to get active topology")
                console.log(err);
            });
    }



    function getTopologies() {
        axios
            .get("/topologies")
            .then(res => {
                setKnownTopologies(res.data.topologies);
                // Also load topology info if name is already configued
                //const topologyName = localStorage.getItem("currentTopologyName");
                // Load topology only if name is set
                //if ( !(topologyName === "null")) {loadTopologyByName(topologyName);} 
            })
            .catch(err => {
                console.log(err);
            });
    }

    // When used, first get available topologies
    useEffect(getTopologies, []);
    useEffect(getLoadedTopology, [])

    return (
        <TopologyContext.Provider value={{ knownTopologies, getTopologies, currentTopologyName, setCurrentTopologyName, loadTopologyByName, getLoadedTopology, loadedTopology, loadedHosts, setLoadedHosts, loadedSwitches, setLoadedSwitches, setLoadedTopology }}>
            {children}
        </TopologyContext.Provider>
    )
}
