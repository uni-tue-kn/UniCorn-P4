import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import axios from 'axios';
import { useSnackbar } from './SnackbarContext';
import { useSwitch } from './SwitchContext';

const InitContext = createContext(null);
export const useInit = () => useContext(InitContext);

export function InitProvider({ children }) {
  const { callSnackbar } = useSnackbar();
  const { currentSwitchID } = useSwitch();
  const [loaded, setLoaded] = useState(null);
  const currentID = useRef(currentSwitchID);
  currentID.current = currentSwitchID;
  const requestID = useRef(0);
  const initializedFiles = loaded?.switchID === currentSwitchID ? loaded.files : null;

  const updateInitializedFiles = useCallback(async () => {
    const request = ++requestID.current;
    if (currentSwitchID == null) { setLoaded(null); return; }
    try {
      const res = await axios.get('/init', { params: { switch_id: currentSwitchID } });
      if (request === requestID.current && currentID.current === currentSwitchID) setLoaded({ switchID: currentSwitchID, files: res.data });
    } catch (err) {
      if (request === requestID.current) setLoaded(null);
    }
  }, [currentSwitchID]);
  useEffect(() => { updateInitializedFiles(); }, [updateInitializedFiles]);

  async function initialize(event, p4_info_file, bmv2_file, keep_entries = false, state_id = null) {
    try {
      await axios.post('/init', { switch_id: currentSwitchID, p4_info_file, bmv2_file, keep_entries, state_id });
      callSnackbar('success', 'Initialization was successful!');
      if (currentID.current === currentSwitchID) await updateInitializedFiles();
      return true;
    } catch (err) {
      callSnackbar('error', err.response?.data?.error || String(err.response?.data || err.message));
      return false;
    }
  }

  return <InitContext.Provider value={{ initializedFiles, updateInitializedFiles, initialize }}>{children}</InitContext.Provider>;
}
