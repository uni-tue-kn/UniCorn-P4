import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { getContrastRatio, useTheme } from '@mui/material/styles';
import { ThemeProviderWrapper } from './ThemeContext';

function Colors() {
  const theme = useTheme();
  return <pre data-testid="palette">{JSON.stringify(theme.palette)}</pre>;
}
beforeEach(() => localStorage.setItem('darkMode', 'true'));
it('keeps dark button labels legible in normal and hover states', () => {
  render(<ThemeProviderWrapper><Colors /></ThemeProviderWrapper>);
  const palette = JSON.parse(screen.getByTestId('palette').textContent);
  for (const family of ['primary', 'secondary']) {
    for (const state of ['main', 'dark']) {
      expect(getContrastRatio(palette[family].contrastText, palette[family][state])).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(getContrastRatio(palette.primary.main, palette.background.paper)).toBeGreaterThanOrEqual(4.5);
});
