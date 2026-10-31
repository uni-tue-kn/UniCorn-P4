import React from 'react';
import { Stack, Button, Typography, TextField, InputLabel, MenuItem, Box, FormControl, Divider, Checkbox, FormControlLabel, Alert } from '@mui/material'
import { Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material'

import { InlineTableRow, InlineTableCell, displayMatchType } from './DisplayHelper';

export function selectTable(tableInfo, handler, selected = null, tableNames = null) {
  return (
    <FormControl style={{ minWidth: 250 }}>
      <TextField select label='Table' defaultValue={selected ? selected : null} name='table_name' onChange={handler}>
        {getTableOptions(tableInfo, tableNames)}
      </TextField>
    </FormControl>
  )
}

function getTableOptions(tableInfo, tableNames = null) {
  const optionNames = tableNames ?? Object.keys(tableInfo ?? {});

  return (
    optionNames.map((table_name) => (
      <MenuItem key={table_name} value={table_name}>{tableInfo?.[table_name]?.table_name ?? table_name}</MenuItem>
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
    const selectedActionInfo = tableInfo[tableName].actions?.[selectedAction];

    if (!selectedActionInfo) {
      return (
        <TextField
          size={size}
          value="Select action first!"
          disabled
        />
      )
    }

    const action_params = selectedActionInfo.params;
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
                value={entryData.action_params?.[param_name] ?? ""}
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
      value={entryData.priority ?? ""}
      required
      onChange={id ? (event) => handler(event, id) : handler} />
  )
}

export function switchInput(switchConfig, switchesOnline, handler, handlerDropdownChange) {
  const builtInRegisters = (switchesOnline?.switches_online || []).some(item => item.name === switchConfig.name
    && item.dev_id === switchConfig.device_id && switchConfig.address === `127.0.0.1:${item.grpc_port}`);
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
      <Divider />
      <Typography variant="subtitle2">BMv2 management (optional)</Typography>
      <Typography variant="body2" color="text.secondary">Queue controls use the switch's Thrift endpoint. Leave the host empty for a P4Runtime-only connection.</Typography>
      <FormControlLabel control={<Checkbox name="register_adapter_enabled" checked={builtInRegisters || Boolean(switchConfig.register_adapter_enabled)} disabled={builtInRegisters} onChange={handler} />} label={builtInRegisters ? 'Built-in register support enabled' : 'Enable BMv2 register adapter'} />
      {builtInRegisters && <Alert severity="info">Register support is enabled automatically for internal switches, including signed and unsigned values up to 64 bits.</Alert>}
      {!builtInRegisters && switchConfig.register_adapter_enabled &&
        <Alert severity="info">Use this for a stock external BMv2 switch without P4Runtime register support. Provide the switch's reachable Thrift endpoint explicitly. The adapter supports registers up to 63 bits.</Alert>
      }
      <TextField label="BMv2 Thrift host" name="register_thrift_host" value={switchConfig.register_thrift_host || ''} required={Boolean(switchConfig.register_adapter_enabled)} onChange={handler} helperText="Hostname or IP reachable from the backend" />
      <TextField label="BMv2 Thrift port" name="register_thrift_port" value={switchConfig.register_thrift_port ?? 9090} required={Boolean(switchConfig.register_adapter_enabled || switchConfig.register_thrift_host)} onChange={handler} slotProps={{ htmlInput: { inputMode: 'numeric', min: 1, max: 65535 } }} helperText="1–65535" />
    </Stack>
  )
}
