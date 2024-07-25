import React, { useState, useEffect } from 'react';

import { useInit } from '../../Contexts/InitContext';
import { useSnackbar } from '../../Contexts/SnackbarContext';
import SaveStateDialog from '../SwitchStates/Dialogs/SaveStateDialog';

import axios from 'axios';
import { Box, Stack, Typography, Paper, Chip } from '@mui/material';
import { TextField, MenuItem, FormControl, FormGroup, FormControlLabel, Checkbox, Button, IconButton, Tooltip } from '@mui/material'
import { TableContainer, Table, TableHead, TableBody, TableRow } from '@mui/material'

import { StyledTableCell } from '../Helpers/DisplayHelper';
import { displayFile } from '../Helpers/DisplayHelper';

import DescriptionIcon from '@mui/icons-material/Description';
import SettingsIcon from '@mui/icons-material/Settings';
import DownloadIcon from '@mui/icons-material/Download';
import CloseIcon from '@mui/icons-material/Close';
import SaveIcon from '@mui/icons-material/Save';
import LibraryAddIcon from '@mui/icons-material/LibraryAdd';
import MoveDownIcon from '@mui/icons-material/MoveDown';

// Object to manage the p4-program files
const initialFileState = {
    "p4_info": null,
    "bmv2": null
};

function Initialization() {

    const { initializedFiles, initialize } = useInit();
    const { callSnackbar } = useSnackbar();

    // Fetch the name of the p4-files in the project from the api every time on load
    const [fileNames, setFileNames] = useState(initialFileState);
    useEffect(() => {
        axios
            .get("/p4files")
            .then(res => {
                setFileNames(res.data);
            })
            .catch(err => {
                console.log(err);
            });
    }, []);

    // Determines if the user is currently editing the files to initialize
    const [editingFiles, setEditingFiles] = useState(false);

    //Set editing to false if initialization is triggered from history or saved states
    useEffect(() => setEditingFiles(false), [initializedFiles]);

    const handleClick = (event) => {
        setEditingFiles(!editingFiles);
    }

    // Contains the files which the user has selected
    const [selectedFiles, setSelectedFiles] = useState(initialFileState);

    const handleFileChange = (event) => {
        event.preventDefault();
        const fileType = event.target.name;
        const newSelectedFile = event.target.value;
        const newSelectedFiles = { ...selectedFiles };
        newSelectedFiles[fileType] = newSelectedFile;
        setSelectedFiles(newSelectedFiles);
    }

    // Function for a new initialization (not based on history or saved state)
    const newInit = (event) => {
        initialize(event, selectedFiles.p4_info, selectedFiles.bmv2, keepEntries);
        setSelectedFiles(initialFileState);
        setEditingFiles(false);
    }

    // State to manage, if the keep table entries checkbox is checked or not
    const [keepEntries, setKeepEntries] = useState(false);

    const handleCheckbox = (event) => {
        setKeepEntries(!keepEntries);
    }

    // State to manage if the save dialog is open or not
    const [saveOpen, setSaveOpen] = useState(false);

    const handleSaveClick = (event) => {
        setSaveOpen(true);
    }


    return (
        <Box id='Dashboard Initialization'>
            <Stack direction='column' spacing={2}>
                <Stack direction='row' spacing={2} justifyContent='space-between'>
                    <Typography color='primary' variant='h6'>Initialization</Typography>
                    <Tooltip title="Takes a snapshot of the current state and saves it as a new state">
                        <Button
                            disabled={initializedFiles?.p4_info_file == null}
                            size='small'
                            variant='contained'
                            endIcon={<LibraryAddIcon />}
                            onClick={(event) => handleSaveClick(event)}
                        >
                            Save state
                        </Button>
                    </Tooltip>
                </Stack>
                <Stack direction='column' spacing={2}>
                    <TableContainer component={Paper} sx={{ borderRadius: "20px" }}>
                        <Table>
                            <TableHead>
                                <TableRow >
                                    <StyledTableCell sx={{ borderRight: 1, width: '50%' }} >P4 info file</StyledTableCell>
                                    <StyledTableCell sx={{ borderLeft: 1, width: '50%' }} >bmv2 file</StyledTableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {!editingFiles ?
                                    (initializedFiles?.p4_info_file == null && initializedFiles?.bmv2_file == null ?
                                        (initializedFiles?.table_info == null ?
                                            <TableRow>
                                                <StyledTableCell colSpan={2}>
                                                    <Typography variant='body1' color='error'>
                                                        No p4-program has been initialized!
                                                    </Typography>
                                                </StyledTableCell>
                                            </TableRow>
                                            :
                                            <TableRow>
                                                <StyledTableCell colSpan={2}>
                                                    <Typography variant='body1' color='warning.dark'>
                                                        Another controller already installed a P4-program on the switch.
                                                        You can modify the table entries in the current session, but you need to provide the P4 info file and the bmv2 file if you want to save the state of initialization!
                                                    </Typography>
                                                </StyledTableCell>
                                            </TableRow>
                                        )
                                        :
                                        <TableRow>
                                            <StyledTableCell>
                                                <Chip
                                                    icon={<DescriptionIcon />}
                                                    label={displayFile(initializedFiles.p4_info_file)}
                                                />
                                            </StyledTableCell>
                                            <StyledTableCell>
                                                <Chip
                                                    icon={<DescriptionIcon />}
                                                    label={displayFile(initializedFiles.bmv2_file)}
                                                />
                                            </StyledTableCell>

                                        </TableRow>
                                    )
                                    :
                                    <>
                                        <TableRow>
                                            <StyledTableCell>
                                                <FormControl sx={{ minWidth: 150 }}>
                                                    <TextField
                                                        select
                                                        label='p4 info file'
                                                        name='p4_info'
                                                        defaultValue=''
                                                        required
                                                        onChange={handleFileChange}
                                                        helperText='Please select p4 info file (.txt)'
                                                        size='small'
                                                    >
                                                        {fileNames.p4_info.length > 0 ?
                                                            fileNames.p4_info.map((file) => (
                                                                <MenuItem value={file}>{displayFile(file)}</MenuItem>
                                                            ))
                                                            :
                                                            <MenuItem disabled>No p4 info file found!</MenuItem>
                                                        }
                                                    </TextField>
                                                </FormControl>
                                            </StyledTableCell>
                                            <StyledTableCell>
                                                <FormControl sx={{ minWidth: 150 }}>
                                                    <TextField
                                                        select
                                                        label='bmv2 file'
                                                        name='bmv2'
                                                        defaultValue=''
                                                        required
                                                        onChange={handleFileChange}
                                                        helperText='Please select bmv2 file (.json)'
                                                        size='small'
                                                    >
                                                        {fileNames.bmv2.length > 0 ?
                                                            fileNames.bmv2.map((file) => (
                                                                <MenuItem value={file}>{displayFile(file)}</MenuItem>
                                                            ))
                                                            :
                                                            <MenuItem disabled>No bmv2 file found!</MenuItem>
                                                        }
                                                    </TextField>
                                                </FormControl>
                                            </StyledTableCell>
                                        </TableRow>
                                        {initializedFiles?.table_info != null &&
                                            <TableRow>
                                                <StyledTableCell colSpan={2} align='left' sx={{ padding: 0, paddingLeft: 2 }}>
                                                    <FormGroup>
                                                        <FormControlLabel
                                                            control={<Checkbox />}
                                                            label="Keep existing entries"
                                                            labelPlacement="end"
                                                            onChange={handleCheckbox}
                                                        />
                                                    </FormGroup>
                                                </StyledTableCell>
                                            </TableRow>
                                        }
                                    </>
                                }
                            </TableBody>
                        </Table>
                    </TableContainer>
                    {editingFiles ?
                        <Stack direction='column' spacing={1}>
                            <Stack direction='row' spacing={1}>
                                <Button
                                    fullWidth variant='contained' endIcon={<CloseIcon />}
                                    onClick={handleClick}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    fullWidth variant='contained' endIcon={<DownloadIcon />}
                                    disabled={(selectedFiles.p4_info == null || selectedFiles.bmv2 == null)}
                                    onClick={newInit}
                                >
                                    Initialize
                                </Button>
                            </Stack>
                        </Stack>
                        :
                        <Button variant='contained' endIcon={<SettingsIcon />} onClick={handleClick}>Edit initialization</Button>
                    }

                </Stack>
            </Stack>
            {initializedFiles != null && <SaveStateDialog open={saveOpen} setOpen={setSaveOpen} />}

        </Box>
    )
}

export default Initialization