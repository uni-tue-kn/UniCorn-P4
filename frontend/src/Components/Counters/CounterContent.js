import React, { useState, useEffect } from 'react';
import axios from 'axios';

import { useSnackbar } from '../../Contexts/SnackbarContext';

import { Box, Button, Typography, Grid, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TableSortLabel } from "@mui/material";
import LoopIcon from '@mui/icons-material/Loop';

import { useSwitch } from '../../Contexts/SwitchContext';

export default function CounterContent({ counterId, counterName }) {
    const { callSnackbar } = useSnackbar();
    const { currentSwitchID } = useSwitch();
    const [order, setOrder] = useState("asc");
    const [orderBy, setOrderBy] = useState("index");

    const [counterEntries, setCounterEntries] = useState(null);

    // State to make sure, the table entries fetched from the api refer to the same table as this component
    const [requestedCounterId, setRequestedCounterId] = useState(null);


    const handleSort = (property) => {
        const isAsc = orderBy === property && order === "asc";
        setOrder(isAsc ? "desc" : "asc");
        setOrderBy(property);
        setCounterEntries([...counterEntries].sort((a, b) => {
            const valA = isNaN(a[property]) ? a[property] : Number(a[property]);
            const valB = isNaN(b[property]) ? b[property] : Number(b[property]);
            return (isAsc ? valA < valB : valA > valB) ? -1 : 1;
        }));
    };


    function updateCounterEntries(counterId) {
        axios
            .get("/counters", {
                params: {
                    counter_id: counterId,
                    switch_id: currentSwitchID
                }
            })
            .then(res => {
                const parsedData = JSON.parse(res.data.data.replace(/'/g, '"'));
                setCounterEntries(parsedData.entries);
                setRequestedCounterId(counterId);
            })
            .catch(err => {
                callSnackbar("error", err.response?.data?.error || "There was an error while fetching the counter entries");
                console.log(err);
            });
    }

    useEffect(() => {
        if (counterId && counterId !== requestedCounterId) {
            updateCounterEntries(counterId);
        }
    }, [counterId, requestedCounterId]);


    if (requestedCounterId == counterId) {

        return (
            <Box sx={{ flexGrow: 1 }}>
                <Typography variant="h5" gutterBottom>
                    {counterName}
                </Typography>
                <Grid container>
                    <Grid item xs={12} xl={10}>
                        <Paper sx={{ padding: "32px", overflow: "hidden" }} elevation={3}>
                            <Button variant='contained' startIcon={< LoopIcon />} size='large' sx={{ width: 250 }} onClick={() => updateCounterEntries(counterId)}>Refresh</Button>
                            <TableContainer>
                                <Table>
                                    <TableHead>
                                        <TableRow>
                                            {['index', 'packets', 'bytes'].map((col) => (
                                                <TableCell key={col}>
                                                    <TableSortLabel
                                                        active={orderBy === col}
                                                        direction={orderBy === col ? order : "asc"}
                                                        onClick={() => handleSort(col)}
                                                    >
                                                        <b>{col.charAt(0).toUpperCase() + col.slice(1)}</b>
                                                    </TableSortLabel>
                                                </TableCell>
                                            ))}
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {counterEntries.map((entry, index) => (
                                            <TableRow key={index}>
                                                <TableCell>{entry.index}</TableCell>
                                                <TableCell>{entry.packets}</TableCell>
                                                <TableCell>{entry.bytes}</TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        </Paper>
                    </Grid>
                </Grid>
            </Box>
        );
    };
}

