import React, {createContext, useContext, useEffect, useState} from 'react';
import axios from 'axios'
import { useSnackbar } from './SnackbarContext';

import { useSwitch } from './SwitchContext';

const InitContext = createContext(null);

export function useInit(){
    return useContext(InitContext) ;
}

export function InitProvider({ children }) {
    // Contexts
    const { callSnackbar } = useSnackbar();
    
    const { currentSwitchID } = useSwitch();

    const [initializedFiles, setInitializedFiles] = useState();
    
    function updateInitializedFiles() {
        if (currentSwitchID != null) {
        axios
            .get("/init", {
                params: { 
                    switch_id: currentSwitchID,
                }
            })
            .then(res => {
                setInitializedFiles(res.data);
            })
            .catch(err => {
                console.log(err);
            });
        }
    }
    //console.log(initializedFiles)
    useEffect(updateInitializedFiles, [currentSwitchID]);

    function initialize(event, p4_info_file, bmv2_file, keep_entries = false, id = null) {
        console.log(id);
        axios
            .post("/init", {
                switch_id:currentSwitchID,
                p4_info_file: p4_info_file,
                bmv2_file: bmv2_file,
                keep_entries: keep_entries,
                state_id: id
            })
            .then(() => {
                updateInitializedFiles();
                callSnackbar("success", "Initialization was successful!");
            })
            .catch(err => {
                console.log(err);
                callSnackbar("error", err.response.data.error || "There was an error during the initialization!" + err.response.data);
            });
    }

    return (
        <InitContext.Provider value={{initializedFiles, updateInitializedFiles, initialize}}>
            {children}
        </InitContext.Provider>
    )
}