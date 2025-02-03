import React, { useState, useEffect } from 'react';

import axios from 'axios';
import { Box, Typography, Paper, Grid } from '@mui/material';
import { TextField, MenuItem, FormControl, Button, } from '@mui/material'
import { TableContainer, Table, TableHead, TableBody, TableRow } from '@mui/material'

import { StyledTableCell } from '../Helpers/DisplayHelper';
import { displayFile } from '../Helpers/DisplayHelper';

import DownloadIcon from '@mui/icons-material/Download';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';

// Object to manage the p4-program files
const initialFileState = {
    "p4src": [],
};

function Compile() {

    // Result from compilation
    const [consoleOutput, setConsoleOutput] = useState("");
    const [compilationSuccess, setCompilationSuccess] = useState(null);

    // Contains the files which the user has selected
    const [selectedFile, setSelectedFile] = useState("");

    // Fetch the name of the p4-files in the project from the api every time on load
    const [fileNames, setFileNames] = useState(initialFileState);
    useEffect(() => {
        axios
            .get("/p4src")
            .then(res => {
                setFileNames(res.data);
                console.log(res.data)
            })
            .catch(err => {
                console.log(err);
            });
    }, []);

    const handleFileChange = (event) => {
        event.preventDefault();
        setSelectedFile(event.target.value);
        console.log(selectedFile)
    }

    const startCompile = (event) => {
        const command = `Compiling ${selectedFile}`;
        setConsoleOutput(command + "\n...");

        axios
            .post("/compile", {
                file: selectedFile
            })
            .then(res => {
                const jsArray = JSON.parse(res.data.command.replace(/'/g, '"'));
                // Join into a single command string
                const commandString = jsArray.join(" ");

                setConsoleOutput(prev => prev + `\nCommand: ${commandString}`);
                setConsoleOutput(prev => prev + "\nSuccess: Compilation completed.");
                setCompilationSuccess(true);
                console.log(res.data)
            })
            .catch(err => {
                const jsArray = JSON.parse(err.response.data.command.replace(/'/g, '"'));
                // Join into a single command string
                const commandString = jsArray.join(" ");

                setConsoleOutput(prev => prev + `\nCommand: ${commandString}`);
                setConsoleOutput(prev => prev + `\nError: ${err.response?.data.stderr || 'Compilation failed.'}`);
                setCompilationSuccess(false);
                console.log(err);
            });
    }

    return (

        <Box id='Compilation'>
            <Typography variant='h5' gutterBottom>P4 Compilation</Typography>
            <Grid container spacing={{ xs: 2, lg: 3 }}>
                <Grid item xs={10} lg={6} xl={5} >
                    <Paper sx={{ padding: '32px', height: 700, overflow: 'auto' }} elevation={3}>
                        <TableContainer component={Paper} sx={{ borderRadius: "20px" }}>
                            <Table>
                                <TableHead>
                                    <TableRow >
                                        <StyledTableCell sx={{ borderRight: 1, width: '50%' }} >P4 source file</StyledTableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    <TableRow>
                                        <StyledTableCell>
                                            <FormControl sx={{ minWidth: 150 }}>
                                                <TextField
                                                    select
                                                    label='P4 source file'
                                                    name='p4src'
                                                    defaultValue=''
                                                    required
                                                    onChange={handleFileChange}
                                                    helperText='Please select P4 source file to compile!'
                                                    size='small'
                                                >
                                                    {fileNames.p4src.length > 0 ?
                                                        fileNames.p4src.map((file) => (
                                                            <MenuItem value={file}>{displayFile(file)}</MenuItem>
                                                        ))
                                                        :
                                                        <MenuItem disabled>No P4 source file found!</MenuItem>
                                                    }
                                                </TextField>
                                            </FormControl>
                                        </StyledTableCell>
                                    </TableRow>
                                </TableBody>
                            </Table>
                        </TableContainer>
                        <Button
                            fullWidth variant='contained' endIcon={<DownloadIcon />}
                            disabled={(selectedFile == null || selectedFile == "")}
                            onClick={startCompile}
                        >
                            Compile
                        </Button>
                        <TextField
                            fullWidth
                            multiline
                            minRows={3}
                            value={consoleOutput}
                            variant='outlined'
                            margin='normal'
                            InputProps={{ readOnly: true }}
                        />     
                        {compilationSuccess !== null && (
                            <Box display="flex" justifyContent="center" mt={2}>
                                {compilationSuccess ? (
                                    <CheckCircleIcon color="success" fontSize="large" />
                                ) : (
                                    <CancelIcon color="error" fontSize="large" />
                                )}
                            </Box>
                        )}                                           
                    </Paper>
                </Grid>
            </Grid>
        </Box>

    )
}

export default Compile