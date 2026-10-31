import React from 'react'

import { Routes, Route, Navigate } from 'react-router-dom';

import SwitchMenu from '../SwitchConnections/SwitchDashboard/SwitchMenu';
import Compile from '../Development/Compile';
import Dashboard from '../Dashboard/Dashboard';
import TableContent from '../Tables/TableContent';
import MenuHistory from '../SwitchStates/History/MenuHistory';
import MenuLogs from '../SwitchStates/Logs/MenuLogs'
import MenuSaved from '../SwitchStates/Saved/MenuSaved';
import NotFound from './NotFound';
import Mininet from '../Mininet/Mininet';
import Terminals from '../Mininet/Terminals';

//import { useTableInfo } from '../../Contexts/InfoContext';
import { useTable } from '../../Contexts/TableContext';
import { useCounter } from '../../Contexts/CounterContext';
import CounterContent from '../Counters/CounterContent';
import ResourceContent from '../Resources/ResourceContent';
import { useInit } from '../../Contexts/InitContext';
import MirrorContent from '../Mirrors/MirrorContent';
import MulticastContent from '../Multicast/MulticastContent';
import DigestContent from '../Digests/DigestContent';
import QueueContent from '../Queues/QueueContent';


function MainRoutes() {
  const { tableInfo } = useTable();
  const { counterInfo } = useCounter();
  const { initializedFiles } = useInit();

  return (
    <Routes>
      <Route
        index
        path='/'
        element={<SwitchMenu />}
      />
      <Route
        path='/switches'
        element={<SwitchMenu />}
      />
      <Route
        path='/compile'
        element={<Compile />}
      />      
      <Route
        path='/dashboard'
        element={<Dashboard />}
      />
      <Route
        path='/logs'
        element={<MenuLogs />}
      />      
      <Route
        path='/history'
        element={<MenuHistory />}
      />
      <Route
        path='/saved'
        element={<MenuSaved />}
      />
      <Route
        path='/topology'
        element={<Mininet />}
        />
      <Route path="/mininet" element={<Navigate to="/topology" replace />} />
      <Route path="/terminals" element={<Terminals />} />
      <Route path="/mirrors" element={<MirrorContent />} />
      <Route path="/multicast-groups" element={<MulticastContent />} />
      <Route path="/digests" element={<DigestContent />} />
      <Route path="/queues" element={<QueueContent />} />
      {tableRoutes(tableInfo)}
      {counterRoutes(counterInfo)}
      {['registers', 'meters', 'direct_meters'].flatMap(kind => Object.entries(initializedFiles?.[kind] || {}).map(([name, resource]) => <Route key={`${kind}:${name}`} path={`/${kind.replace('_', '-')}/${name}`} element={<ResourceContent key={`${kind}:${resource.id}`} kind={kind.replace('_', '-')} resourceName={name} resource={resource} />} />))}
      <Route 
        path="*" 
        element={<NotFound />} 
      />
    </Routes>
  )
}

function tableRoutes(tableInfo) {
  if (tableInfo != undefined) {
    return (
      Object.entries(tableInfo).map(([table_name, table_data]) => (
        <Route
          key={table_name}
          path={'/tables/' + table_name}
          element={<TableContent tableName={table_name} tableID={table_data.table_id} />}
        />
      ))
    )
  }
}

function counterRoutes(counterInfo) {
  if (counterInfo != undefined) {
    return (
      Object.entries(counterInfo).map(([counter_name, counter_data]) => (
        <Route
          key={counter_name}
          path={'/counters/' + counter_name}
          element={<CounterContent counterId={counter_data.id} counterName={counter_name} />}
        />
      ))
    )
  }
}

export default MainRoutes
