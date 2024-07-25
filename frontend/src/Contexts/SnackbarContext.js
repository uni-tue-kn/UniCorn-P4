import React, {createContext, useContext, useState} from 'react';

const SnackbarContext = createContext({});

export function useSnackbar(){
    return useContext(SnackbarContext) ;
}

export function SnackbarProvider({ children }) {
    
    const [snackbarState, setSnackbarState] = useState({ 
        open: false,
        severity: null,
        content: null,
    });

    const callSnackbar = (severity, content) => {
        setSnackbarState({
            open: true,
            severity: severity,
            content: content
        })
    }

    const closeSnackbar = () => {
        setSnackbarState({
            open: false,
            severity: null,
            content: null
        });
    }

    return (
        <SnackbarContext.Provider value={{ snackbarState, callSnackbar, closeSnackbar }}>
            {children}
        </SnackbarContext.Provider>
    )
}