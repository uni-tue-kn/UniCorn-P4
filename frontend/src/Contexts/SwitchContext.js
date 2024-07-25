import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios'

const SwitchContext = createContext({});

export function useSwitch() {
    return useContext(SwitchContext);
}

export function SwitchProvider({ children }) {

    const [currentSwitchID, setCurrentSwitchID] = useState(() => {
        const storedSwitchID = localStorage.getItem('currentSwitchID');
        return storedSwitchID ? JSON.parse(storedSwitchID) : null;
    });
    const [switches, setSwitches] = useState([]);
    const [switchesOnline, setSwitchesOnline] = useState({"switches_online": []});
    const [historySwitches, setHistorySwitches] = useState([]);

    useEffect(() => {
        localStorage.setItem('currentSwitchID', JSON.stringify(currentSwitchID));
    }, [currentSwitchID]);



    function getSwitches() {
        axios
            .get("/switches/active", {
                params: {
                    switch_id: currentSwitchID
                }
            })
            .then(res => {
                setSwitches(res.data['connections']);
                (!res.data['current_switch_connected']) && setCurrentSwitchID(null);
            })
            .catch(err => {
                console.log(err);
            });
    }

    function getSwitchesOnline() {
        axios
            // TODO dont hardcode the netsim api here
            .get("http://localhost:5001/switches/online", {
            })
            .then(res => {
                setSwitchesOnline(res.data);
            })
            .catch(err => {
                console.log(err);
            });        
    }

    function getHistorySwitches() {
        axios
            .get("/switches/known")
            .then(res => {
                setHistorySwitches(res.data);
            })
            .catch(err => {
                console.log(err);
            });
    }

    useEffect(getSwitches, []);
    useEffect(getSwitchesOnline, []);
    useEffect(getHistorySwitches, []);

    function deleteSwitch(device_id) {
        axios
            .delete("/switches/active", {
                data: {
                    device_id: device_id
                }
            })
            .then(res => {
                setCurrentSwitchID(null);
                getSwitches();
                getHistorySwitches();
            })
            .catch(err => {
                console.log(err)
            });
    }



    return (
        <SwitchContext.Provider value={{switchesOnline, getSwitchesOnline, switches, getSwitches, currentSwitchID, setCurrentSwitchID, deleteSwitch, historySwitches, getHistorySwitches }}>
            {children}
        </SwitchContext.Provider>
    )
}