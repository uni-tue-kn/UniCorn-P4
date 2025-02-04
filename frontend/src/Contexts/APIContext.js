import React, { createContext, useContext, useEffect, useState } from 'react';
import axios from 'axios'

const APIContext = createContext(null);

export function useAPI() {
  return useContext(APIContext);
}

export function APIProvider({ children }) {
  // Contexts    
  const [backendOnline, setBackendOnline] = useState(false)
  const [mininetOnline, setMininetOnline] = useState(false)

  const loadStatus = async () => {
    // Backend
    axios
      .get("/switches/active", {
      })
      .then(res => {
        setBackendOnline(true)
      })
      .catch(err => {
        setBackendOnline(false)
      });

    if (backendOnline) {
      // Mininet
      axios
        .get("http://localhost:5001/switches/online", {
        })
        .then(res => {
          setMininetOnline(true)
        })
        .catch(err => {
          setMininetOnline(false)
        });
    }
  }


  loadStatus();

  // Continously poll both backends for status
  useEffect(() => {

    const interval = setInterval(loadStatus, 5000)

    return () => {
      clearInterval(interval)
    }

  }, [loadStatus])

  return (
    <APIContext.Provider value={{ backendOnline, setBackendOnline, mininetOnline, setMininetOnline }}>
      {children}
    </APIContext.Provider>
  )
}