import TopologySelector from './TopologySelector';
import {Stack, Typography} from '@mui/material';
import TopologyRenderer from './TopologyRenderer';

export default function Topology() {

    return(
        <Stack direction='column' spacing={2}>
                <Typography color='primary.text' variant='h6'>Saved Topologies</Typography>
                <TopologySelector></TopologySelector>
                <TopologyRenderer></TopologyRenderer>
            </Stack>
        
    )
}