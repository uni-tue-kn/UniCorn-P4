import React, { useState } from 'react'

import { displayTable, displayActionData, displayMatchKeys, checkForPriority } from '../../Helpers/DisplayHelper';
import { StyledTableCell, StyledTableRow } from '../../Helpers/DisplayHelper';
import { selectTable } from '../../Helpers/InputHelper';
import { decodeTableEntries } from '../../Helpers/Decoding/DecodingHelper';
import DecodingOptions from '../../Tables/DecodingOptions';

import { Stack, IconButton, Typography, FormControl, Button, Collapse } from '@mui/material';
import { Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';

import SettingsIcon from '@mui/icons-material/Settings';
import CloseIcon from '@mui/icons-material/Close';


function TablePreviewDialog({ tablePreview, setTablePreview }) {

  const exitPreview = (event) => {
    setPreviewTableName(null);
    setTablePreview(null);
  }

  const [previewTableName, setPreviewTableName] = useState(null);

  const handleTableChange = (event) => {
    event.preventDefault();
    const selectedTable = event.target.value;
    setPreviewTableName(selectedTable);
  }

  const[previewDecoding, setPreviewDecoding] = useState(tablePreview['decoding']);

  const[decodingOpen, setDecodingOpen] = useState(false);

  if (tablePreview != undefined) {
    const tableInfo = tablePreview['table_info'];


    const needsPriority = (previewTableName != null ? checkForPriority(tableInfo, previewTableName) : false);

    const previewRow = (entry) => {
      return (
        <StyledTableRow>
          <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{displayMatchKeys(entry, tableInfo, previewTableName)}</StyledTableCell>
          <StyledTableCell sx={{ padding: 0 }} colSpan={2}>{displayActionData(entry)}</StyledTableCell>
          {needsPriority && <StyledTableCell>{entry.switch_entry.priority}</StyledTableCell>}
        </StyledTableRow>
      )
    }
    
    const decodedEntries = decodeTableEntries(tablePreview['entries'][previewTableName], previewDecoding, tableInfo, previewTableName)
    return (
      <Dialog open={tablePreview != null} maxWidth='xl' fullWidth >
        <DialogTitle>
          Table Preview
          <IconButton
            onClick={(event) => exitPreview(event)}
            sx={{
              position: 'absolute',
              right: 8,
              top: 8,
              color: (theme) => theme.palette.grey[500],
            }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Stack direction='column' spacing={2}>
            <Typography></Typography>
            <Stack direction='row' spacing={2}>
              <FormControl style={{ maxWidth: 300 }}>
                {selectTable(tablePreview['table_info'], handleTableChange)}
              </FormControl>
              <Button variant='outlined' endIcon={<SettingsIcon />} disabled={previewTableName == null} onClick={(event) => setDecodingOpen(!decodingOpen)} >Decoding Options</Button>
            </Stack>
            <Collapse in={decodingOpen} unmountOnExit>
                {previewTableName != null && <DecodingOptions tableName={previewTableName} tableInfo={tableInfo} decoding={previewDecoding} setDecoding={setPreviewDecoding} />}
              </Collapse>
            {previewTableName != null &&
              ((tablePreview['entries'][previewTableName].length > 0) ?
                displayTable(previewRow, decodedEntries, needsPriority, false) :
                <Typography color='error'>The table has no entries</Typography>)}
          </Stack>
        </DialogContent>
        <DialogActions>
        </DialogActions>
      </Dialog>
    )
  }
}



export default TablePreviewDialog