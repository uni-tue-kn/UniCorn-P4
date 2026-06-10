import React, { createContext, useContext, useMemo, useState } from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';

const ThemeContext = createContext(null);

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProviderWrapper({ children }) {
  // Contexts    
  const [darkMode, setDarkMode] = useState(() => {
    let storedTheme = localStorage.getItem("theme");

    if (!storedTheme) {
      storedTheme = window.matchMedia(
        "(prefers-color-scheme: dark)"
      ).matches;
      localStorage.setItem("theme", storedTheme);
    }
    return storedTheme;
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
          primary: {
            main: darkMode ? '#9f8ce8' : '#1d103c',
            light: darkMode ? '#4f3f74' : '#4a3f63',
            dark: darkMode ? '#2b1b4f' : '#120926',
            contrastText: '#ffffff',
            text: darkMode ? '#ffffff' : '#1d103c',
          },
          secondary: {
            main: darkMode ? '#31c6b8' : '#00887c',
            light: darkMode ? '#2a9f96' : '#33a097',
            dark: darkMode ? '#006f66' : '#005f57',
            contrastText: '#ffffff',
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
