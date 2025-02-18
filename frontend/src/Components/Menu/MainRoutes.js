import React from 'react'

import { Routes, Route } from 'react-router';

import SwitchMenu from '../SwitchConnections/SwitchDashboard/SwitchMenu';
import Compile from '../Development/Compile';
import Dashboard from '../Dashboard/Dashboard';
import TableContent from '../Tables/TableContent';
import MenuHistory from '../SwitchStates/History/MenuHistory';
import MenuLogs from '../SwitchStates/Logs/MenuLogs'
import MenuSaved from '../SwitchStates/Saved/MenuSaved';
import NotFound from './NotFound';
import Mininet from '../Mininet/Mininet';

//import { useTableInfo } from '../../Contexts/InfoContext';
import { useTable } from '../../Contexts/TableContext';
import { useCounter } from '../../Contexts/CounterContext';
import CounterContent from '../Counters/CounterContent';


function MainRoutes() {
  const { tableInfo } = useTable();
  const { counterInfo } = useCounter();

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
        path='/mininet'
        element={<Mininet />}
        />
      {tableRoutes(tableInfo)}
      {counterRoutes(counterInfo)}
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
          path={'/counters/' + counter_name}
          element={<CounterContent counterId={counter_data.id} counterName={counter_name} />}
        />
      ))
    )
  }
}

export default MainRoutes