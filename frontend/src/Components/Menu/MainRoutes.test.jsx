import React from 'react';
import { expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import MainRoutes from './MainRoutes';

vi.mock('../../Contexts/TableContext', () => ({ useTable: () => ({ tableInfo: {} }) }));
vi.mock('../../Contexts/CounterContext', () => ({ useCounter: () => ({ counterInfo: {} }) }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ initializedFiles: {} }) }));
vi.mock('../Mininet/Mininet', () => ({ default: () => <h2>Topology canvas</h2> }));
vi.mock('../Mininet/Terminals', () => ({ default: () => <h2>Network terminals</h2> }));
vi.mock('../Development/Editor', () => ({ default: () => <h2>P4 workspace</h2> }));
function Location() { return <p data-testid="route">{useLocation().pathname}</p>; }
it('redirects legacy Mininet links to the topology page', async () => {
  render(<MemoryRouter initialEntries={['/mininet']}><MainRoutes /><Location /></MemoryRouter>);
  expect(await screen.findByRole('heading', { name: 'Topology canvas' })).toBeVisible();
  await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/topology'));
});
it('provides a separate terminal route without the topology canvas', () => {
  render(<MemoryRouter initialEntries={['/terminals']}><MainRoutes /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Network terminals' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Topology canvas' })).not.toBeInTheDocument();
});
it('opens legacy compile bookmarks in the integrated editor', async () => {
  render(<MemoryRouter initialEntries={['/compile']}><MainRoutes /><Location /></MemoryRouter>);
  expect(await screen.findByRole('heading', { name: 'P4 workspace' })).toBeVisible();
  await waitFor(() => expect(screen.getByTestId('route')).toHaveTextContent('/editor'));
});
