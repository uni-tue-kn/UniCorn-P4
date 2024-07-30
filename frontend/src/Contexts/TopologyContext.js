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

    // State thas saves list of known Topologies
    const [knownTopologies, setKnownTopologies] = useState([]);
    const [loadedTopology, setLoadedTopology] = useState("");
    const [loadedHosts, setLoadedHosts] = useState([]);

    // Topology that is currently loaded
    // Will try to fetch this from local storage, is set to null if none is stored
    const [currentTopologyName, setCurrentTopologyName] = useState(() => {
        const topologyName = localStorage.getItem("currentTopologyName");
        return (topologyName === "null") ? null : topologyName;
    });

    // Request topology data from backend and store state
    function loadTopologyByName(name) {
        axios
            .get("/topologies", {
                params: {
                    "name": name
                }
            })
            .then(res => {
                // Store name for new topology
                setCurrentTopologyName(name);
                // Store topology Data
                setLoadedTopology(res.data[name]);
            })
            .catch(err => {
                callSnackbar("errpr","Failed to load topology with name: "+name)
                console.log(err);
            });
    }

    // Store loaded topology name on use
    useEffect(() => {
        localStorage.setItem("currentTopologyName", currentTopologyName);
    }, [currentTopologyName])

    function getTopologies() {
        axios
            .get("/topologies")
            .then(res => {
                setKnownTopologies(res.data.topologies);
                // Also load topology info if name is already configued
                const topologyName = localStorage.getItem("currentTopologyName");
                // Load topology only if name is set
                if ( !(topologyName === "null")) {loadTopologyByName(topologyName);} 
            })
            .catch(err => {
                console.log(err);
            });
    }

    // When used, first get available topologies
    useEffect(getTopologies, []);

    return (
        <TopologyContext.Provider value={{knownTopologies, getTopologies, currentTopologyName, setCurrentTopologyName,loadTopologyByName,loadedTopology,loadedHosts,setLoadedHosts}}>
            {children}
        </TopologyContext.Provider>
    )
}
