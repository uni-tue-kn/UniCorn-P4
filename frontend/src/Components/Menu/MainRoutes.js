import React from 'react'

import { Routes, Route } from 'react-router';

import SwitchMenu from '../SwitchConnections/SwitchDashboard/SwitchMenu';
import Dashboard from '../Dashboard/Dashboard';
import TableContent from '../Tables/TableContent';
import MenuHistory from '../SwitchStates/History/MenuHistory';
import MenuSaved from '../SwitchStates/Saved/MenuSaved';
import NotFound from './NotFound';

//import { useTableInfo } from '../../Contexts/InfoContext';
import { useTable } from '../../Contexts/TableContext';


function MainRoutes() {
  const { tableInfo } = useTable();

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
        path='/dashboard'
        element={<Dashboard />}
      />
      <Route
        path='/history'
        element={<MenuHistory />}
      />
      <Route
        path='/saved'
        element={<MenuSaved />}
      />
      {tableRoutes(tableInfo)}
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
          element={<TableContent tableName={table_name} />}
        />
      ))
    )
  }
}

export default MainRoutes