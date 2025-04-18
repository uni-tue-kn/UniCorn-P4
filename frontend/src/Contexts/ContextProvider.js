import React from 'react'
import { TableProvider } from './TableContext'
import { InitProvider } from './InitContext'
import { SnackbarProvider } from './SnackbarContext'
import { SwitchProvider } from './SwitchContext'
import { TopologyProvider } from './TopologyContext'
import { APIProvider } from './APIContext'
import { ThemeProviderWrapper } from './ThemeContext'
import { CounterProvider } from './CounterContext'

function ContextProvider({ children }) {
  return (
    <ThemeProviderWrapper>
      <SnackbarProvider>
        <APIProvider>
          <SwitchProvider>
            <TopologyProvider>
              <InitProvider>
                <TableProvider>
                  <CounterProvider>
                  {children}
                  </CounterProvider>
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