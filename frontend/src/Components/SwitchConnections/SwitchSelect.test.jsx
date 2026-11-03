import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import SwitchSelect from './SwitchSelect';

const select = vi.hoisted(() => vi.fn());
let connections, selected, online;
beforeEach(() => { connections = []; selected = null; online = false; });
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ switches: connections, currentSwitchID: selected, setCurrentSwitchID: select }) }));
vi.mock('../../Contexts/APIContext', () => ({ useAPI: () => ({ backendOnline: online }) }));
vi.mock('./SwitchDashboard/AddNewSwitch', () => ({ default: () => null }));
function Location() { return <p data-testid="route">{useLocation().pathname}</p>; }
it('links to separate topology and terminal pages for the same network', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/dashboard']}><SwitchSelect /><Location /></MemoryRouter>);
  expect(screen.queryByRole('link', { name: 'Mininet' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('link', { name: 'Topology' }));
  expect(screen.getByTestId('route')).toHaveTextContent('/topology');
  await user.click(screen.getByRole('link', { name: 'Terminals' }));
  expect(screen.getByTestId('route')).toHaveTextContent('/terminals');
  expect(select).toHaveBeenCalledWith(null);
});

it('keeps switch tabs mounted and focused through background refreshes and layout changes', () => {
  online = true; selected = 0; connections = [{ name: 's1', device_id: 0 }];
  const theme = createTheme();
  const tree = compact => <MemoryRouter><ThemeProvider theme={theme}><SwitchSelect compact={compact} /></ThemeProvider></MemoryRouter>;
  const view = render(tree(false));
  const tab = screen.getByRole('tab', { name: 's1' });
  expect(tab).toHaveAttribute('aria-selected', 'true');
  tab.focus();
  connections = [{ name: 's1', device_id: 0 }];
  view.rerender(tree(false));
  expect(screen.getByRole('tab', { name: 's1' })).toBe(tab);
  expect(tab).toHaveFocus();
  view.rerender(tree(true));
  expect(screen.getByRole('tab', { name: 's1' })).toBe(tab);
  expect(tab).toHaveFocus();
});
