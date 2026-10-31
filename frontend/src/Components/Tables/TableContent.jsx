import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import JSONbig from 'json-bigint';

import EditableTable from './EditableTable'
import ReadableTable from './ReadableTable';
import PostTableEntry from './PostTableEntry';

import { useInit } from '../../Contexts/InitContext';
import { useTable } from '../../Contexts/TableContext'
import { useSnackbar } from '../../Contexts/SnackbarContext';

import { Box, Grid, Paper, Stack, Typography, Button, Collapse } from '@mui/material'
import EditIcon from '@mui/icons-material/Edit';
import AddIcon from '@mui/icons-material/Add';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import SettingsIcon from '@mui/icons-material/Settings';
import SearchIcon from '@mui/icons-material/Search';
import SortIcon from '@mui/icons-material/Sort';

import SortFilter from './SortFilter';
import DecodingOptions from './DecodingOptions';
import { decodeTableEntries } from '../Helpers/Decoding/DecodingHelper';
import SaveStateDialog from '../SwitchStates/Dialogs/SaveStateDialog';
import { checkForPriority } from '../Helpers/DisplayHelper';
import { filterEntries, sortEntries } from '../Helpers/SortFilter/SortFilterHelper';
import { useSwitch } from '../../Contexts/SwitchContext';
import DirectCounterReset from '../Counters/DirectCounterReset';


export default function TableContent({ tableName, tableID }) {
  const { tableInfo, decoding, setDecoding } = useTable();
  const { callSnackbar } = useSnackbar();
  const { initializedFiles } = useInit();
  const { currentSwitchID } = useSwitch();
  const currentRequest = useRef(0);


  const [tableEntries, setTableEntries] = useState(null);

  // State to make sure, the table entries fetched from the api refer to the same table as this component
  const [requestedTableName, setRequestedTableName] = useState(null);

  const updateTableEntries = useCallback((requestedName = tableName) => {
    const request = ++currentRequest.current;
    if (currentSwitchID == null) {
      setTableEntries(null);
      setRequestedTableName(null);
      return;
    }

    axios
      .get("/tables", {
        transformResponse: [function (data) {
          try {
            return JSONbig({ storeAsString: true }).parse(data);
          } catch (err) {
            console.error("Failed to parse big int JSON:", err);
            return data;
          }
        }],
        params: {
          switch_id: currentSwitchID,
          table_name: requestedName
        }
      })
      .then(res => {
        if (request !== currentRequest.current) return;
        setTableEntries(res.data);
        setRequestedTableName(requestedName);
      })
      .catch(err => {
        if (request !== currentRequest.current) return;
        callSnackbar("error", err.response?.data?.error || "There was an error while fetching the table entries");
        console.log(err);
      });
  }, [callSnackbar, currentSwitchID, tableName]);


  useEffect(() => {
    setTableEntries(null);
    updateTableEntries(tableName);
    return () => { currentRequest.current++; };
  }, [tableID, tableName, currentSwitchID, updateTableEntries]);

  // Table modes 
  const [inlineEditing, setInlineEditing] = useState(false);
  function toggleInlineEditing() {
    setInlineEditing(!inlineEditing);
  }

  const [editing, setEditing] = useState(false);
  function toggleEditing() {
    setEditing(!editing);
  }

  const [adding, setAdding] = useState(false);
  function toggleAdding() {
    setAdding(!adding);
  }

  // State to handle if one of the options is opened or not
  const [optionsOpen, setOptionsOpen] = useState(false);

  const handleChange = (event, option) => {
    setOptionsOpen(optionsOpen === option ? false : option);
  };

  const [filtering, setFiltering] = useState({
    table_name: tableName,
    match_fields: {},
    action_name: null,
    action_params: {},
    priority: null
  });

  const [sorting, setSorting] = useState({
    match_key: null,
    descending: true
  });

  useEffect(() => {
    setFiltering({
      table_name: tableName,
      match_fields: {},
      action_name: null,
      action_params: {},
      priority: null
    });
    setSorting({
      match_key: null,
      descending: true
    });
    setOptionsOpen(false);
    setEditing(false);
    setInlineEditing(false);
    setAdding(false);
  }, [tableName, currentSwitchID]);

  // State to manage if the save dialog is open or not
  const [saveOpen, setSaveOpen] = useState(false);

  const handleSaveClick = (event) => {
    setSaveOpen(true);
  }


  if (requestedTableName === tableName && tableEntries != null) {
    const sortedEntries = sortEntries(tableEntries, sorting);
    const decodedEntries = decodeTableEntries(sortedEntries, decoding, tableInfo, tableName);
    const filteredEntries = filterEntries(decodedEntries, filtering)
    const needsPriority = checkForPriority(tableInfo, tableName)

    const commonProps = {
      tableName,
      tableEntries: decodedEntries,
      rawTableEntries: tableEntries,
      updateTableEntries,
      filteredEntries,
      needsPriority,
    };

    return (
      <Box sx={{ flexGrow: 1 }}>
        <Typography variant='h5' gutterBottom>{tableName}</Typography>
        <Grid container >
          <Grid size={{ xs: 12, xl: 10 }}>
            <Paper sx={{ padding: '32px', overflow: 'hidden' }} elevation={3}>
              <Stack direction='column' spacing={2} >
                <Stack direction='row' spacing={2} sx={{ justifyContent: 'space-between', flexWrap: 'wrap' }} useFlexGap>
                  <Stack direction='row' spacing={2} sx={{ flexWrap: 'wrap' }} useFlexGap>
                    <Button variant='contained' startIcon={< AddIcon />} size='large' sx={{ width: 250 }} disabled={editing || inlineEditing} onClick={toggleAdding}>Add new Entry</Button>
                    <Button variant='contained' endIcon={< EditIcon />} size='large' sx={{ width: 250 }} disabled={tableEntries.length === 0 || editing || inlineEditing} onClick={toggleEditing}>Edit Table Entries</Button>
                    <Button variant='outlined' startIcon={<SortIcon />} sx={{ backgroundColor: 'action.hover' }} endIcon={<SearchIcon />} disabled={editing || inlineEditing} onClick={(event) => handleChange(event, "sort&filter")} >Sort & Filter</Button>
                    <Button variant='outlined' endIcon={<SettingsIcon />} sx={{ backgroundColor: 'action.hover' }} disabled={editing || inlineEditing} onClick={(event) => handleChange(event, "decoding")} >Decoding Options</Button>
                  </Stack>
                  <Button variant='contained' endIcon={<LibraryAddIcon />} disabled={(editing || inlineEditing) || initializedFiles?.state_id === null || initializedFiles?.state_id === undefined} onClick={(event) => handleSaveClick(event)}>
                    Save state
                  </Button>
                  {Object.values(initializedFiles?.direct_counters || {}).some(counter => counter.table_id === tableID) && <DirectCounterReset tableID={tableID} disabled={editing || inlineEditing || tableEntries.length === 0} onReset={() => updateTableEntries(tableName)} />}
                </Stack>
                <Collapse in={optionsOpen === "sort&filter" && !(editing || inlineEditing)} unmountOnExit>
                  <SortFilter tableName={tableName} filtering={filtering} setFiltering={setFiltering} sorting={sorting} setSorting={setSorting} needsPriority={needsPriority} />
                </Collapse>
                <Collapse in={optionsOpen === "decoding" && !(editing || inlineEditing)} unmountOnExit>
                  <DecodingOptions tableName={tableName} tableInfo={tableInfo} decoding={decoding} setDecoding={setDecoding} />
                </Collapse>
                {editing ?
                  < EditableTable {...commonProps} toggleEditing={toggleEditing} />
                  :
                  <ReadableTable {...commonProps} toggleInlineEditing={toggleInlineEditing} />}
              </Stack>
            </Paper>
          </Grid>
        </Grid>
        {adding && <PostTableEntry tableName={tableName} updateTableEntries={updateTableEntries} toggleAdding={toggleAdding} needsPriority={needsPriority} />}
        <SaveStateDialog open={saveOpen} setOpen={setSaveOpen}></SaveStateDialog>
      </Box>
    )
  }

  return null;
}

