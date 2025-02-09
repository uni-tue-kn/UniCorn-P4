import React from 'react'
import { TableProvider } from './TableContext'
import { InitProvider } from './InitContext'
import { SnackbarProvider } from './SnackbarContext'
import { SwitchProvider } from './SwitchContext'
import { TopologyProvider } from './TopologyContext'
import { APIProvider } from './APIContext'
import { ThemeProviderWrapper } from './ThemeContext'

function ContextProvider({ children }) {
  return (
    <ThemeProviderWrapper>
      <SnackbarProvider>
        <APIProvider>
          <SwitchProvider>
            <TopologyProvider>
              <InitProvider>
                <TableProvider>
                  {children}
                </TableProvider>
              </InitProvider>
            </TopologyProvider>
          </SwitchProvider>
        </APIProvider>
      </SnackbarProvider>
    </ThemeProviderWrapper>
  )
}

export default ContextProvider