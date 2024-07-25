import React from 'react'
import { Stack, Button, Typography, TextField, InputLabel, MenuItem, Box, FormControl, Divider } from '@mui/material'
import { Table, TableHead, TableBody, TableRow, TableCell } from '@mui/material'

import { InlineTableRow, InlineTableCell, displayMatchType } from './DisplayHelper';
import { matchDataInput, selectAction, actionParamsInput } from './InputHelper'

export function editMatchInput(tableInfo, tableName, editEntryData, handler, id = null, deleted = false) {
    return (
      <Table sx={{ border: 0 }}>
        <TableBody>
          {Object.entries(tableInfo[tableName].match_fields).map(([match_key, match_data]) => (
            <InlineTableRow>
              <InlineTableCell width='50%'>{match_key + " (" + displayMatchType(tableInfo[tableName].match_fields[match_key].match_type) + ")"}</InlineTableCell>
              <InlineTableCell width='50%'>{matchDataInput(tableInfo, tableName, match_key, editEntryData, handler, id, deleted)} </InlineTableCell>
            </InlineTableRow>
          )
          )}
        </TableBody>
      </Table>
    )
}

export function editActionInput(tableInfo, tableName, editEntryData, handler, id = null, deleted = false) {
    return (
        <Table sx={{ border: 0 }}>
          <TableBody>
            <InlineTableRow>
              <InlineTableCell >{selectAction(tableInfo, tableName, editEntryData, handler, id, deleted)}</InlineTableCell>
              <InlineTableCell>{actionParamsInput(tableInfo, tableName, editEntryData, handler, id, deleted)} </InlineTableCell>
            </InlineTableRow>
          </TableBody>
        </Table>
      )
}

export function findEntry(id, data) {
    return data.find(entry => entry.id === id);
  }