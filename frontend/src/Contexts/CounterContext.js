import React, { createContext, useContext, useState, useEffect } from 'react';

import { useInit } from './InitContext';

const CounterContext = createContext({});

export function useCounter() {
    return useContext(CounterContext);
}

export function CounterProvider({ children }) {
    const [counterInfo, setCounterInfo] = useState(null);

    const { initializedFiles } = useInit();
    

    function updateCounterInfo() {
        if (initializedFiles != null) {
            if (initializedFiles.counters !== undefined){
                setCounterInfo(initializedFiles.counters)
            }
       }

    }

    
    useEffect(updateCounterInfo, [initializedFiles]);

    return (
        <CounterContext.Provider value={{ counterInfo, setCounterInfo}}>
            {children}
        </CounterContext.Provider>
    )
    
}