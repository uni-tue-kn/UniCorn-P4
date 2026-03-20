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

    useEffect(() => {
        setTableInfo(initializedFiles?.table_info ?? null);
    }, [initializedFiles]);

    useEffect(() => {
        if (currentSwitchID == null || initializedFiles?.table_info == null) {
            setDecoding(null);
            return;
        }

        axios
            .get("/decoding", {
                params: {
                    switch_id: currentSwitchID,
                    state_id: (initializedFiles.state_id || null)
                }
            })
            .then(res => {
                setDecoding(res.data);
            })
            .catch(err => {
                console.log(err);
            });
    }, [currentSwitchID, initializedFiles]);

    useEffect(() => {
        if (initializedFiles?.state_id == null || decoding === undefined || decoding === null) {
            return;
        }

        axios
            .post("/decoding", {
                state_id: initializedFiles.state_id,
                decoding: JSON.stringify(decoding)
            })
            .catch(err => {
                console.log(err);
            });
    }, [decoding, initializedFiles]);

    return (
        <TableContext.Provider value={{ tableInfo, setTableInfo, decoding, setDecoding }}>
            {children}
        </TableContext.Provider>
    )
    
}
