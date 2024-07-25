import React from 'react'
import { TableProvider } from './TableContext'
import { InitProvider } from './InitContext'
import { SnackbarProvider } from './SnackbarContext'
import { SwitchProvider } from './SwitchContext'
import { TopologyProvider } from './TopologyContext'

function ContextProvider({ children }) {
  return (
    <SnackbarProvider>
      <SwitchProvider>
      <TopologyProvider>
      <InitProvider>
        <TableProvider>
          {children}
        </TableProvider>
      </InitProvider>
      </TopologyProvider>
      </SwitchProvider>
    </SnackbarProvider>
  )
}

export default ContextProvider