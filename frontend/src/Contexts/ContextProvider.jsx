import React from 'react'
import { TableProvider } from './TableContext'
import { InitProvider } from './InitContext'
import { SnackbarProvider } from './SnackbarContext'
import { SwitchProvider } from './SwitchContext'
import { TopologyProvider } from './TopologyContext'
import { APIProvider } from './APIContext'
import { ThemeProviderWrapper } from './ThemeContext'
import { CounterProvider } from './CounterContext'
import { TerminalProvider } from './TerminalContext'
import { EditorProvider } from './EditorContext'

function ContextProvider({ children }) {
  return (
    <ThemeProviderWrapper>
      <SnackbarProvider>
        <APIProvider>
          <SwitchProvider>
            <TopologyProvider>
              <TerminalProvider>
              <InitProvider>
                <TableProvider>
                  <CounterProvider>
                    <EditorProvider>
                      {children}
                    </EditorProvider>
                  </CounterProvider>
                </TableProvider>
              </InitProvider>
              </TerminalProvider>
            </TopologyProvider>
          </SwitchProvider>
        </APIProvider>
      </SnackbarProvider>
    </ThemeProviderWrapper>
  )
}

export default ContextProvider
