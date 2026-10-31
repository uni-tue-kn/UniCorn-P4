import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SwitchSelect from './SwitchSelect';

const select = vi.hoisted(() => vi.fn());
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ switches: [], currentSwitchID: null, setCurrentSwitchID: select }) }));
vi.mock('../../Contexts/APIContext', () => ({ useAPI: () => ({ backendOnline: false }) }));
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
