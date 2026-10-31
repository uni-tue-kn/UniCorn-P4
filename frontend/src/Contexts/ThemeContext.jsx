import React, { createContext, useContext, useMemo, useState } from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';

const ThemeContext = createContext(null);

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProviderWrapper({ children }) {
  // Contexts    
  const [darkMode, setDarkMode] = useState(() => {
    const storedTheme = localStorage.getItem('darkMode');
    return storedTheme === null ? window.matchMedia('(prefers-color-scheme: dark)').matches : storedTheme === 'true';
  });

  const toggleDarkMode = () => {
    setDarkMode((prevMode) => {
      localStorage.setItem('darkMode', !prevMode);
      return !prevMode;
    });
  };

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: darkMode ? 'dark' : 'light',
          contrastThreshold: 4.5,
          primary: {
            main: darkMode ? '#c4b5fd' : '#1d103c',
            light: darkMode ? '#e1d6ff' : '#4a3f63',
            dark: darkMode ? '#a38ae8' : '#120926',
            contrastText: darkMode ? '#170d30' : '#ffffff',
            text: darkMode ? '#ffffff' : '#1d103c',
          },
          secondary: {
            main: darkMode ? '#31c6b8' : '#00887c',
            light: darkMode ? '#5eead4' : '#33a097',
            dark: darkMode ? '#22ab9f' : '#005f57',
            contrastText: darkMode ? '#052e2b' : '#ffffff',
          },
          text: {
            primary: darkMode ? '#ffffff' : '#1d103c', // White text in dark mode, dark text in light mode
            secondary: darkMode ? '#c2bfd0' : '#666666', // Lighter secondary text for dark mode
          },          
          background: {
            default: darkMode ? '#121212' : '#ffffff', // Standard dark mode background
            paper: darkMode ? '#1e1e1e' : '#f5f5f5', // Cards and surfaces
          },
        },
        components: {
          MuiTab: {
            styleOverrides: {
              root: ({ theme }) => ({
                color: theme.palette.text.secondary,
                '&.Mui-selected': {
                  color: theme.palette.mode === 'dark'
                    ? theme.palette.primary.main
                    : theme.palette.primary.dark,
                },
              }),
            },
          },
          MuiTabs: {
            styleOverrides: {
              indicator: ({ theme }) => ({
                backgroundColor: theme.palette.mode === 'dark'
                  ? theme.palette.primary.main
                  : theme.palette.primary.dark,
              }),
            },
          },
        },
      }),
    [darkMode]
  );

  return (
    <ThemeContext.Provider value={{ darkMode, toggleDarkMode }}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>    </ThemeContext.Provider>
  )
}
