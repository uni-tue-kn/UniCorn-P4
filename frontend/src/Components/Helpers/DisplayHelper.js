import { TableContainer, Table, TableHead, TableBody, TableRow, TableCell, Paper, Stack, List } from '@mui/material'
import { styled } from '@mui/material/styles';
import { tableCellClasses } from '@mui/material/TableCell';

export const TopTableHeadCell = styled(TableCell)(({ theme }) => ({
    [`&.${tableCellClasses.head}`]: {
        color: theme.palette.primary.contrastText,
        backgroundColor: theme.palette.primary.main,
        fontSize: "1.3rem"
    }
}));


export const StyledTableCell = styled(TableCell)(({ theme }) => ({
    [`&.${tableCellClasses.head}`]: {
        backgroundColor: theme.palette.primary.light,
        color: theme.palette.primary.contrastText,
        fontSize: "1rem"

    },
    [`&.${tableCellClasses.body}`]: {
        fontSize: 14,
    },
}));


export const StyledTableRow = styled(TableRow)(({ theme }) => ({
    '&:nth-of-type(even)': {
        backgroundColor: theme.palette.action.hover,
    },
    '&.error-row': {
        backgroundColor: theme.palette.error.light,
      },
}));


export const InlineTableCell = styled(TableCell)(({ theme }) => ({
    [`&.${tableCellClasses.body}`]: {
        border: 0,
        whiteSpace: 'normal',
        wordWrap: 'break-word',
    },
}));

export const InlineTableRow = styled(TableRow)(({ theme }) => ({
    '&:': {
        borderTop: 0,
        borderRight: 0,
        borderLeft: 0
    },
    // hide last border
    '&:last-child td, &:last-child th': {
        borderBottom: "none"
    },
}));


export function displayTable(rowFunction, tableEntries, needsPriority = false, editable = true) {
    return (
        <Paper sx={{  overflow: 'hidden' }}>
        <TableContainer sx={{maxHeight: 'calc(100vh - 325px)'}}>
            <Table stickyHeader>
                <TableHead>
                    <TableRow>
                        <TopTableHeadCell sx={{borderRight: 1, width: '40%', textAlign: 'center' }} colSpan={2}>Match</TopTableHeadCell>
                        <TopTableHeadCell sx={{borderLeft: 1, borderRight: 1, width: '40%', textAlign: 'center'}} colSpan={2}>Action</TopTableHeadCell>
                        {needsPriority && <TopTableHeadCell sx={{borderLeft: 1 , borderRight: 1, width: '10%'}} ></TopTableHeadCell>}
                        {editable && <TopTableHeadCell sx={{borderLeft: 1 , width: '10%'}} align='center'  ></TopTableHeadCell>}
                    </TableRow>
                    <TableRow>
                        <StyledTableCell  width='20%' >Key &#40;Type&#41;</StyledTableCell>
                        <StyledTableCell sx={{borderRight: 1}} width='20%' >Value</StyledTableCell>
                        <StyledTableCell sx={{borderLeft: 1}} width='20%' >Name</StyledTableCell>
                        <StyledTableCell  width='20%' sx={{borderRight: 1}} >Parameters</StyledTableCell>
                        {needsPriority && <StyledTableCell  sx={{borderLeft: 1, borderRight: 1}} >Priority</StyledTableCell>}
                        {editable && <StyledTableCell  sx={{borderLeft: 1}} align='center'>Options</StyledTableCell>}
                    </TableRow>
                </TableHead>
                <TableBody>
                    {(tableEntries).map((entry) => {
                        return rowFunction(entry);
                    }
                    )}
                </TableBody>
            </Table>
        </TableContainer>
        </Paper>
    )
}

export function displayActionParams(entry) {
    const action_params = entry.switch_entry.action_params;
    if (action_params != null) {
        return (
            <>
                {(Object.keys(action_params).length > 0 ?
                    <Table sx={{ border: 0, display: 'inline-flex',  tableLayout: 'fixed'}}>
                        <TableBody>
                            {Object.entries(action_params).map(([param, value]) => (
                                <InlineTableRow>
                                    <InlineTableCell sx={{ padding: 0 }}>{param}:</InlineTableCell>
                                    <InlineTableCell sx={{ padding: 0, paddingLeft: 1,  wordBreak: 'break-word' }} >{value}</InlineTableCell>
                                </InlineTableRow>
                            ))}
                        </TableBody>
                    </Table>
                    :
                    <>No parameters</>
                )
                }
            </>
        )
    }
}

export function displayActionData(entry){
    return(
        <Table sx={{border: 0, tableLayout: 'fixed'}}>
            <TableBody>
                <InlineTableRow>
                    <InlineTableCell>{entry.switch_entry.action_name}</InlineTableCell>
                    <InlineTableCell>{displayActionParams(entry)}</InlineTableCell>
                </InlineTableRow>
            </TableBody>
        </Table>
    )
}
export function displayMatchKeys(entry, tableInfo, tableName) {
    return (
        <Table sx={{border: 0, tableLayout: 'fixed'}}>
            <TableBody>
            {(Object.entries(entry.switch_entry.match_fields).map(([key, value]) => {
                const match_type = tableInfo[tableName].match_fields[key].match_type;
                return (
                    <InlineTableRow>
                        <InlineTableCell  width='50%'>{key + " (" + displayMatchType(match_type) + ")"}</InlineTableCell>
                        <InlineTableCell  width='50%'>{displayMatchValues(value, match_type)}</InlineTableCell>
                    </InlineTableRow>
                )
            })
            )}
            </TableBody>
        </Table>
    )
}

export function displayMatchType(match_type) {
    switch (match_type) {
        case 1:
            return
        case 2:
            return "exact";
        case 3:
            return "lpm";
        case 4:
            return "ternary";
        case 5:
            return "range";
        case 6:
            return "optional";
    }
}

function displayMatchValues(match_value, match_type) {
    switch (match_type) {
        case 2:
        case 6:    
          return match_value;
        case 3:
            return (match_value[0] + " / " + match_value[1])
        case 4:
            return (match_value[0] + " & " + match_value[1])
        case 5:
            return ("(" + match_value[0] + ", " + match_value[1] + ")")    
    }
}


export function displayFile(file_path) {
    const folder_path = "/app/controller/p4_files/";
    if (file_path.includes(folder_path)) {
        return file_path.substring(folder_path.length);
    }
    return file_path;
}

export function checkForPriority(tableInfo, tableName) {
    const match_fields = tableInfo[tableName].match_fields;
    const needsPriority = Object.values(match_fields).some(
        (match_field) => match_field.match_type === 4 || match_field.match_type === 5);
    return needsPriority;
}
