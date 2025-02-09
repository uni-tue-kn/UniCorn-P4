import React from 'react'
import { Stack, Button, Typography, TextField, InputLabel, MenuItem, Box, FormControl, Divider } from '@mui/material'

import { matchDataInput, selectAction, actionParamsInput, priorityInput } from './InputHelper'

export function postEntryInput(tableInfo, tableName, postEntryData, handler, needsPriority) {
    return (
        <Stack direction='column' spacing={2}>
            <Typography variant='h6' color='primary.text'>Match </Typography>
            {postMatchInput(tableInfo, tableName, postEntryData, handler)}
            <Divider flexItem></Divider>
            <Typography variant='h6' color='primary.text'>Action </Typography>
            {postActionInput(tableInfo, tableName, postEntryData, handler)}
            {needsPriority &&
                <React.Fragment>
                    <Divider flexItem></Divider>
                    <Typography variant='h6' color='primary.text'>Priority </Typography>
                    {priorityInput(postEntryData, handler, null, false, 'medium')}
                </React.Fragment>}
        </Stack>
    )
}

function postMatchInput(tableInfo, tableName, postEntryData, handler) {
    return (
        <Stack direction='column' spacing={2}>
            {Object.entries(tableInfo[tableName].match_fields).map(([match_key, match_data]) => (
                <Stack direction='column' spacing={1}>
                    <Typography variant='body1'>{match_key}</Typography>
                    {matchDataInput(tableInfo, tableName, match_key, postEntryData, handler, null, false, 'medium')}
                </Stack>
            )
            )}
        </Stack>
    )
}

function postActionInput(tableInfo, tableName, postEntryData, handler) {
    return (
        <Stack direction="column" spacing={2}>
            {selectAction(tableInfo, tableName, postEntryData, handler, null, false, 'medium')}
            {actionParamsInput(tableInfo, tableName, postEntryData, handler, null, false, 'medium')}
        </Stack>
    )
}

