import React from "react";
import { Stack, Button, Typography, TextField, InputLabel, MenuItem, Box, FormControl, Divider } from '@mui/material'
import { Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material'

import { getActionOptions } from "../InputHelper";
import { InlineTableRow, InlineTableCell, displayMatchType } from '../DisplayHelper';

export function decodingInput(tableInfo, tableName, tableDecoding, matchHandler, selectedAction, actionNameHandler, actionParamsHandler) {
    return (
      <Table>
        <TableHead>
          <TableRow>
            <TableCell width='50%' >Match</TableCell>
            <TableCell width='50%'>Action</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          <TableRow>
            <TableCell sx={{ padding: 0 }}>
              {decodeToggleMatch(tableInfo, tableName, tableDecoding, matchHandler)}
            </TableCell>
            <TableCell sx={{ padding: 0 }}>
              {decodeToggleAction(tableInfo, tableName, tableDecoding, selectedAction, actionNameHandler, actionParamsHandler)}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    )
  }
  
  function decodeToggleMatch(tableInfo, tableName, tableDecoding, handler) {
    return (
      <Stack direction='column' spacing={1}>
        {Object.entries(tableInfo[tableName].match_fields).map(([match_key, match_data], i, arr) => (
          <Stack key={match_key} direction='column' spacing={1}>
            <Table>
              <TableBody>
                <InlineTableRow>
                  <InlineTableCell width='50%'>
                    <Typography
                      sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center'
                      }}
                      variant='body2'>
                      {match_key}
                    </Typography>
                  </InlineTableCell>
                  <InlineTableCell width='50%'>
                    {decodeDropdown(tableDecoding.match?.[match_key] ?? "numeric", match_key, match_data.bitwidth, handler)}
                  </InlineTableCell>
                </InlineTableRow>
              </TableBody>
            </Table>
            {i !== (arr.length - 1) && <Divider />}
          </Stack>
        ))
        }
      </Stack>
    )
  }
  
  function decodeToggleAction(tableInfo, tableName, tableDecoding, selectedAction, nameHandler, paramsHandler) {
    return (
      <Table>
        <TableBody>
          <InlineTableRow>
            <InlineTableCell width='50%'>
              <FormControl style={{ minWidth: 200 }}>
                <TextField
                  size='small'
                  select
                  label='Action'
                  name='action_name'
                  value={selectedAction || ""}
                  required
                  onChange={(event) => nameHandler(event)}
                >
                  {getActionOptions(tableInfo, tableName)}
                </TextField>
              </FormControl>
            </InlineTableCell>
            <InlineTableCell width='50%'>
              {decodeActionParams(tableInfo, tableName, tableDecoding, selectedAction, paramsHandler)}
            </InlineTableCell>
          </InlineTableRow>
        </TableBody>
      </Table>
    )
  }
  
  function decodeActionParams(tableInfo, tableName, tableDecoding, selectedAction, handler) {
    if (selectedAction !== undefined && selectedAction !== null && tableInfo[tableName].actions?.[selectedAction]) {
      const action_params = tableInfo[tableName].actions[selectedAction].params;
      const actionDecoding = tableDecoding.action?.[selectedAction] ?? {};
      if (action_params.length > 0) {
        return (
          <Stack direction='column' spacing={1}>
            {(action_params).map((action_param) => {
              const param_name = action_param.name;
              const bitwidth = action_param.bitwidth;
              return (
                <Stack key={param_name} direction='column' spacing={1}>
                  <Typography variant='body2'>{param_name}:</Typography>
                  {decodeDropdown(actionDecoding[param_name] ?? "numeric", param_name, bitwidth, handler)}
                </Stack>
              )
            })}
          </Stack>
        )
      }
      else {
        return (
          <TextField
            size='small'
            defaultValue="No parameters"
            disabled
          />
        )
      }
    }
    else {
      return (
        <TextField
          size='small'
          defaultValue="Select action first!"
          disabled
        />
      )
    }
  }
  
  function decodeDropdown(value, name, bitwidth, handler) {
    return (
      <FormControl style={{ minWidth: 200 }}>
        <TextField
          size='small'
          label='Decode'
          select
          value={value}
          onChange={(event) => handler(event, name)}
        >
          <MenuItem value="numeric">Numeric</MenuItem>
          <MenuItem value="hexadecimal">Hexadecimal</MenuItem>
          <MenuItem value="binary">Binary</MenuItem>
          <MenuItem value="ipv4" disabled={bitwidth !== 32}>IPv4</MenuItem>
          <MenuItem value="ipv6" disabled={bitwidth !== 128}>IPv6</MenuItem>
          <MenuItem value="mac" disabled={bitwidth !== 48}>MAC</MenuItem>
        </TextField>
      </FormControl>
    )
  }
