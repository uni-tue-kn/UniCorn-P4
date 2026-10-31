import React, { createContext, useContext, useEffect, useState } from 'react';
import axios from 'axios';

const APIContext = createContext(null);
export const useAPI = () => useContext(APIContext);

export function APIProvider({ children }) {
  const [backendOnline, setBackendOnline] = useState(false);
  const [mininetOnline, setMininetOnline] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      await Promise.allSettled([
        axios.get('/switches/active', { signal: controller.signal, timeout: 4000 })
          .then(() => setBackendOnline(true)).catch(() => { if (!controller.signal.aborted) setBackendOnline(false); }),
        axios.get('/netsim/switches/online', { baseURL: '', signal: controller.signal, timeout: 4000 })
          .then(() => setMininetOnline(true)).catch(() => { if (!controller.signal.aborted) setMininetOnline(false); }),
      ]);
      polling = false;
    }
    poll();
    const interval = setInterval(poll, 5000);
    return () => { controller.abort(); clearInterval(interval); };
  }, []);

  return <APIContext.Provider value={{ backendOnline, setBackendOnline, mininetOnline, setMininetOnline }}>{children}</APIContext.Provider>;
}
