import React from 'react';
import { Stack, Button, Typography, TextField, InputLabel, MenuItem, Box, FormControl, Divider } from '@mui/material'
import { Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material'

import { InlineTableRow, InlineTableCell, displayMatchType } from './DisplayHelper';

export function selectTable(tableInfo, handler, selected = null) {
  return (
    <FormControl style={{ minWidth: 250 }}>
      <TextField select label='Table' defaultValue={selected ? selected : null} name='table_name' onChange={handler}>
        {getTableOptions(tableInfo)}
      </TextField>
    </FormControl>
  )
}

function getTableOptions(tableInfo) {
  return (
    Object.entries(tableInfo).map(([table_name, table_data]) => (
      <MenuItem key={table_name} value={table_name}>{table_name}</MenuItem>
    ))
  )
}

export function matchDataInput(tableInfo, tableName, match_key, entryData, handler, id = null, deleted = false, size = 'small') {
  const match_field = tableInfo[tableName].match_fields[match_key];
  const matchFieldDefined = entryData.match_fields[match_key] !== undefined;
  const commonProps = {
    disabled: deleted,
    size: size,
    required: true,
    onChange: id ? (event) => handler(event, id) : handler,
  };

  if (match_field.match_type == 2 || match_field.match_type == 6) {
    return (
      <TextField
        {...commonProps}
        label="Value"
        name="match_value"
        value={matchFieldDefined ? entryData.match_fields[match_key] : ""}
        id={match_key}
      />
    )
  }
  else {
    let label1 = "Value";
    let label2 = null;
    if (match_field.match_type == 3) {
      label2 = 'Prefix length';
    }
    if (match_field.match_type == 4) {
      label2 = 'Mask';
    }
    if (match_field.match_type == 5) {
      label1 = 'Low';
      label2 = 'High';
    }
    return (
      <Stack direction='column' spacing={2}>
        <TextField
          {...commonProps}
          label={label1}
          name="match_value1"
          key="label1"
          value={matchFieldDefined ? entryData.match_fields[match_key][0] : ""}
          id={match_key}
        />
        <TextField
          {...commonProps}
          label={label2}
          name="match_value2"
          key="label2"
          value={matchFieldDefined ? entryData.match_fields[match_key][1] : ""}
          id={match_key}
        />
      </Stack>
    )
  }
}

export function selectAction(tableInfo, tableName, entryData, handler, id = null, deleted = false, size = 'small') {
  return (
    <FormControl style={{ minWidth: 250 }}>
      <TextField
        disabled={deleted}
        size={size}
        select
        label='Action'
        value={entryData.action_name || ""}
        name='action_name'
        key="action"
        required
        onChange={id ? (event) => handler(event, id) : handler}
      >
        {getActionOptions(tableInfo, tableName)}
      </TextField>
    </FormControl>
  )
}

//Helper function to create options for the actions to select in the form
export function getActionOptions(tableInfo, tableName) {
  return (
    Object.entries(tableInfo[tableName].actions).map(([action_name, action_data]) => (
      <MenuItem key={action_name} value={action_name}>{action_data.alias}</MenuItem>
    ))
  )
}

export function actionParamsInput(tableInfo, tableName, entryData, handler, id = null, deleted = false, size = 'small') {
  if (entryData.action_name != undefined) {
    const selectedAction = entryData.action_name
    const action_params = tableInfo[tableName].actions[selectedAction].params;
    if (action_params.length > 0) {
      return (
        <Stack direction='column' spacing={2}>
          {(action_params).map((action_param) => {
            const param_name = action_param.name;
            return (
              <TextField
                disabled={deleted}
                size={size}
                label={param_name}
                name="action_param"
                key='action_param'
                value={entryData.action_params?.[param_name] || ""}
                id={param_name}
                required
                onChange={id ? (event) => handler(event, id) : handler} />
            )
          })}
        </Stack>
      )
    }
    else {
      return (
        <TextField
          size={size}
          value="No parameters"
          disabled
        />
      )
    }
  }
  else {
    return (
      <TextField
        size={size}
        value="Select action first!"
        disabled
      />
    )
  }
}

export function priorityInput(entryData, handler, id = null, deleted = false, size = 'small') {
  return (
    <TextField
      disabled={deleted}
      size={size}
      label="Priority"
      name="priority"
      value={entryData.priority || ""}
      required
      onChange={id ? (event) => handler(event, id) : handler} />
  )
}

export function switchInput(switchConfig, switchesOnline, handler, handlerDropdownChange) {
  return (
    <Stack spacing={2}>
      <div>
        <InputLabel htmlFor="switches_online">
         Found switches
         </InputLabel>
          <TextField
              select
              label='Switch'
              name='switches_online'
              defaultValue=''
              onChange={(event) => handlerDropdownChange(event)}
              helperText='Switches running in mininet'
              size='small'
          >
               {switchesOnline.switches_online.length > 0 ?
                  switchesOnline.switches_online.map((s) => (
                      <MenuItem key={s} value={s}>{s.name}</MenuItem>
                  ))
                  :
                  <MenuItem key="disabled" disabled>No Switch Online!</MenuItem>
              }
          </TextField>
      </div>
      <div>
        <InputLabel shrink={switchConfig.name !== null} htmlFor="switch_name">
          Switch Name
        </InputLabel>
        <TextField
          id="switch_name"
          value={switchConfig.name || ""}
          name="name"
          onChange={(event) => handler(event)}
          fullWidth
          required
        />
      </div>
      <div>
        <InputLabel shrink={switchConfig.address !== null} htmlFor="switch_address">
          Switch Address:Switch Port
        </InputLabel>
        <TextField
          id="switch_address"
          value={switchConfig.address || ""}
          name="address"
          onChange={(event) => handler(event)}
          fullWidth
          required
        />
      </div>
      <div>
        <InputLabel shrink={switchConfig.device_id !== null} htmlFor="switch_device_id">
          Switch Device ID
        </InputLabel>
        <TextField
          id="switch_device_id"
          value={switchConfig.device_id != null ? switchConfig.device_id : ""}
          name="device_id"
          onChange={(event) => handler(event)}
          fullWidth
          required
        />
      </div>
      <div>
        <InputLabel shrink={switchConfig.proto_dump_file !== null} htmlFor="switch_proto_dump_file">
          Switch Proto Dump File
        </InputLabel>
        <TextField
          id="switch_proto_dump_file"
          value={switchConfig.proto_dump_file || ""}
          name="proto_dump_file"
          onChange={(event) => handler(event)}
          fullWidth
        />
      </div>
    </Stack>
  )
}

