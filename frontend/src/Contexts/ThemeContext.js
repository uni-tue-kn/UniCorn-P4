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
            main: darkMode ? '#1d103c' : '#1d103c',
          },
          secondary: {
            main: darkMode ? '#00887c' : '#00887c', // Adjusted for dark mode
          },
          text: {
            primary: darkMode ? '#ffffff' : '#1d103c', // White text in dark mode, dark text in light mode
            secondary: darkMode ? '#868686' : '#666666', // Lighter secondary text for dark mode
          },          
          background: {
            default: darkMode ? '#121212' : '#ffffff', // Standard dark mode background
            paper: darkMode ? '#1e1e1e' : '#f5f5f5', // Cards and surfaces
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