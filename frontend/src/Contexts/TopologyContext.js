import React, { createContext, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { useSnackbar } from './SnackbarContext';

const TopologyContext = createContext(null);

export function useTopology() {
    return useContext(TopologyContext);
}

export function TopologyProvider({ children }) {

    // Get reference for calls to Snackbar Info Banner
    const { callSnackbar } = useSnackbar();

    // State that saves list of known Topologies
    const [knownTopologies, setKnownTopologies] = useState([]);
    const [loadedTopology, setLoadedTopology] = useState("");
    const [loadedHosts, setLoadedHosts] = useState([]);

    // Topology that is currently loaded in Mininet
    const [currentTopologyName, setCurrentTopologyName] = useState("");

    // Request topology data from backend and store state
    function loadTopologyByName() {
        if (currentTopologyName === "") {
            setLoadedTopology("");
            setLoadedHosts([]);
            return;
        }

        console.log("Loading topology....")

        axios
            .get("/topologies", {
                params: {
                    "name": currentTopologyName
                }
            })
            .then(res => {
                // Store topology Data
                setLoadedTopology(res.data[currentTopologyName]);
                setLoadedHosts(res.data[currentTopologyName]["hosts"])
            })
            .catch(err => {
                callSnackbar("error", "Failed to load topology with name: " + currentTopologyName)
                console.log(err);
            });
        console.log(loadedTopology);
    }

    // Get topology that is currently loaded in Mininet and store it in state
    function getLoadedTopology() {
        axios
            .get("http://127.0.0.1:5001/topology/get", {
            })
            .then(res => {
                // Store name for new topology
                if (res.data["file_name"] === null) {
                    setCurrentTopologyName("");
                    setLoadedTopology("");
                } else {
                    setCurrentTopologyName(res.data["file_name"]);
                }
            })
            .catch(err => {
                callSnackbar("error", "Failed to get active topology")
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
    useEffect(loadTopologyByName, [currentTopologyName]);

    return (
        <TopologyContext.Provider value={{ knownTopologies, getTopologies, currentTopologyName, setCurrentTopologyName, loadTopologyByName, getLoadedTopology, loadedTopology, loadedHosts, setLoadedHosts, setLoadedTopology }}>
            {children}
        </TopologyContext.Provider>
    )
}
