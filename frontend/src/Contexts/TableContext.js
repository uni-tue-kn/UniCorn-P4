import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios'

import { useInit } from './InitContext';
import { useSwitch } from './SwitchContext';

const TableContext = createContext({});

export function useTable() {
    return useContext(TableContext);
}

export function TableProvider({ children }) {
    const [tableInfo, setTableInfo] = useState(null);

    const [decoding, setDecoding] = useState(null);

    const { initializedFiles } = useInit();
    const { currentSwitchID } = useSwitch();


    function updateTableInfo() {
        if (initializedFiles != null) {
            if (initializedFiles.table_info !== undefined){
                setTableInfo(initializedFiles.table_info)
            }
       }

    }

    useEffect(updateTableInfo, [initializedFiles]);



    function updateDecoding() {
        if (currentSwitchID != null) {
            if (initializedFiles != null) {
                if (initializedFiles.table_info != null) {
                    axios
                        .get("/decoding", {
                            params: { 
                                switch_id: currentSwitchID,
                                state_id: (initializedFiles.state_id || null) }
                        })
                        .then(res => {
                            setDecoding(res.data);
                        })
                        .catch(err => {
                            console.log(err);
                        });
                }
            }
        }
    }

    function postDecoding() {
        if (initializedFiles != null) {
            if (initializedFiles.state_id != null) {
                if (decoding != undefined) {
                    axios
                        .post("/decoding", {
                            state_id: initializedFiles.state_id,
                            decoding: JSON.stringify(decoding)
                        })
                        .catch(err => {
                            console.log(err);
                        });
                }
            }
        }
    }

    // Fetch decoding from the api every time a new state is initialized
    useEffect(updateDecoding, [initializedFiles]);

    // Post the new decoding to the api every time it changes
    useEffect(postDecoding, [decoding]);

    return (
        <TableContext.Provider value={{ tableInfo, setTableInfo, decoding, setDecoding }}>
            {children}
        </TableContext.Provider>
    )
    
}