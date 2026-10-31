import React from 'react'
import { Stack, Button, Typography, TextField, IconButton, MenuItem, Box, FormControl, Divider, Switch } from '@mui/material'
import { Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material'

import { InlineTableRow, InlineTableCell, displayMatchType } from '../DisplayHelper';

import { matchDataInput, selectAction, getActionOptions, actionParamsInput, priorityInput } from '../InputHelper'

import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';

export function sortFilterInput(tableInfo, tableName, sorting, filtering, sortHandler, filterHandler, needsPriority) {
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableCell width='40%' >Match</TableCell>
          <TableCell width='40%'>Action</TableCell>
          {needsPriority && <TableCell width='20%'>Priority</TableCell>}
        </TableRow>
      </TableHead>
      <TableBody>
        <TableRow>
          <TableCell sx={{ padding: 0 }}>
            {sortFilterMatch(tableInfo, tableName, sorting, filtering, sortHandler, filterHandler)}
          </TableCell>
          <TableCell sx={{ padding: 0 }}>
            {filterAction(tableInfo, tableName, filtering, filterHandler)}
          </TableCell>
          {needsPriority && <TableCell sx={{ padding: 0 }}>{sortFilterPriority(tableInfo, tableName, sorting, filtering, sortHandler, filterHandler)}</TableCell>}
        </TableRow>
      </TableBody>
    </Table>
  )
}


function sortFilterMatch(tableInfo, tableName, sorting, filtering, sortHandler, filterHandler) {
  return (
    <Stack direction='column' spacing={2}>
      {Object.entries(tableInfo[tableName].match_fields).map(([match_key, match_data]) => (
        <Stack direction='column'>
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
                  {matchDataInput(tableInfo, tableName, match_key, filtering, filterHandler)}
                </InlineTableCell>
              </InlineTableRow>
            </TableBody>
          </Table>
          <Divider />
        </Stack>
      ))
      }
      {sortMatch(tableInfo, tableName, sorting, sortHandler)}
    </Stack>
  )
}

function sortMatch(tableInfo, tableName, sorting, sortHandler) {
  return (
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
              Sort Key
            </Typography>
          </InlineTableCell>
          <InlineTableCell width='50%'>
            <Stack direction='row' spacing={2}>

              <FormControl style={{ minWidth: 200 }}>
                <TextField
                  size='small'
                  select
                  label='Sort Key'
                  name='match_key'
                  value={sorting.match_key}
                  onChange={(event) => sortHandler(event)}
                >
                  <MenuItem value={null}>default</MenuItem>
                  {Object.entries(tableInfo[tableName].match_fields).map(([match_key, match_data]) => (
                    <MenuItem value={match_key}>{match_key}</MenuItem>
                  ))}
                </TextField>
              </FormControl>
              <IconButton
                disabled={sorting.match_key === null}
                onClick={sortHandler}
              >
                {sorting.descending ?  <ArrowDownwardIcon color={sorting.match_key === null ? 'default' : 'primary'} /> : <ArrowUpwardIcon color={sorting.match_key === null ? 'default' : 'primary'} />}
              </IconButton>
            </Stack>
          </InlineTableCell>
        </InlineTableRow>
      </TableBody>
    </Table>

  );
}

function filterAction(tableInfo, tableName, filtering, filterHandler) {
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
                value={filtering.action_name}
                onChange={(event) => filterHandler(event)}
              >
                {getActionOptions(tableInfo, tableName)}
              </TextField>
            </FormControl>
          </InlineTableCell>
          <InlineTableCell width='50%'>
            {actionParamsInput(tableInfo, tableName, filtering, filterHandler)}
          </InlineTableCell>
        </InlineTableRow>
      </TableBody>
    </Table>
  )
}

function sortFilterPriority(tableInfo, tableName, sorting, filtering, sortHandler, filterHandler) {
  return priorityInput(filtering, filterHandler)
}