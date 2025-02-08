import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
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
    const [switchesOnline, setSwitchesOnline] = useState({ "switches_online": [] });
    const [historySwitches, setHistorySwitches] = useState([]);

    const [logContent, setLogContent] = useState('');
    const [updateLog, setUpdateLog] = useState(true);
    const [limit, setLimit] = useState(200);


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

    const getLogFile = useCallback(() => {

        if (updateLog) {
            if (switches.length > 0) {
                const s = switches.filter((s => s.device_id === currentSwitchID))
                if (s.length > 0) {
                    const file_name = s[0].name + ".log";

                    axios
                        .get("http://localhost:5001/topology/logs", {
                            params: {
                                file: file_name,
                                limit: limit
                            }
                        })
                        .then(res => {
                            setLogContent(res.data.content)
                        })
                        .catch(err => {
                            if (err.status === 404) {
                                setLogContent("Could not find log file " + file_name + ". Make sure that you connected the switch with the same name as defined in topology.")
                            } else {
                                setLogContent("")
                            }
                            console.log(err);
                        });
                } else {
                    setLogContent("")
                }

            } else {
                setLogContent("")
            }
        }
    })

    // Update log file contents
    useEffect(() => {

        const interval = setInterval(getLogFile, 2000)

        return () => {
            clearInterval(interval)
        }

    }, [getLogFile])

    return (
        <SwitchContext.Provider value={{ switchesOnline, getSwitchesOnline, switches, getSwitches, currentSwitchID, setCurrentSwitchID, deleteSwitch, historySwitches, getHistorySwitches, logContent, setLogContent, updateLog, setUpdateLog, getLogFile, limit, setLimit }}>
            {children}
        </SwitchContext.Provider>
    )
}