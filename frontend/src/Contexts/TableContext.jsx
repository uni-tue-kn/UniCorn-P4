import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { useInit } from './InitContext';
import { useSwitch } from './SwitchContext';

const TableContext = createContext({});
export const useTable = () => useContext(TableContext);
export function TableProvider({ children }) {
  const { initializedFiles } = useInit();
  const { currentSwitchID } = useSwitch();
  const [loaded, setLoaded] = useState(null);
  const tableInfo = initializedFiles?.table_info ?? null;
  const stateID = initializedFiles?.state_id ?? null;
  const key = `${currentSwitchID}:${stateID}`;
  const decoding = loaded?.key === key ? loaded.value : null;
  useEffect(() => {
    if (currentSwitchID == null || tableInfo == null) { setLoaded(null); return; }
    const controller = new AbortController();
    axios.get('/decoding', { params: { switch_id: currentSwitchID, state_id: stateID }, signal: controller.signal })
      .then(res => { if (!controller.signal.aborted) setLoaded({ key, value: res.data }); }).catch(() => {});
    return () => controller.abort();
  }, [currentSwitchID, stateID, key, tableInfo]);
  const setDecoding = useCallback(update => {
    const value = typeof update === 'function' ? update(decoding) : update;
    setLoaded({ key, value });
    if (stateID != null) axios.post('/decoding', { state_id: stateID, decoding: JSON.stringify(value) }).catch(() => {});
  }, [key, stateID, decoding]);
  return <TableContext.Provider value={{ tableInfo, decoding, setDecoding }}>{children}</TableContext.Provider>;
}
