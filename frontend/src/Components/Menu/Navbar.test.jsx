import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Navbar from './Navbar';

vi.mock('../SwitchConnections/SwitchSelect', () => ({ default: () => <div>Switch selection</div> }));
vi.mock('./VersionInfo', () => ({ default: () => <span>Version</span> }));
vi.mock('../../Contexts/ThemeContext', () => ({ useTheme: () => ({ darkMode: false, toggleDarkMode: vi.fn() }) }));
vi.mock('../../Contexts/SwitchContext', () => ({ useSwitch: () => ({ currentSwitchID: 1 }) }));
vi.mock('../../Contexts/InitContext', () => ({ useInit: () => ({ initializedFiles: { registers: { visits: {} } } }) }));
vi.mock('../../Contexts/TopologyContext', () => ({ useTopology: () => ({}) }));
beforeEach(() => {
  localStorage.clear();
  window.matchMedia.mockImplementation(query => ({ matches: query === '(min-width:900px)', media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});
const mount = (route = '/registers/visits') => render(<MemoryRouter initialEntries={[route]}><Navbar /></MemoryRouter>);

it.each(['/topology', '/terminals', '/mininet'])('hides switch resources on %s', route => {
  mount(route);
  expect(screen.queryByRole('navigation', { name: 'Switch resources' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).not.toBeInTheDocument();
});

it('makes the archive menu and mounted upload input available on the compile route', async () => {
  const user = userEvent.setup();
  mount('/compile');
  expect(screen.getByLabelText('Import network archive')).toHaveAttribute('type', 'file');
  expect(screen.queryByRole('button', { name: 'Export network' })).not.toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: 'Network archive' });
  trigger.focus();
  await user.keyboard('{Enter}');
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('menuitem', { name: 'Export network' })).toBeVisible();
  expect(screen.getByRole('menuitem', { name: 'Import network' })).toBeVisible();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
it('persists keyboard resizing and collapse, and opens resource groups from the icon rail', async () => {
  const user = userEvent.setup();
  const view = mount();
  const separator = screen.getByRole('separator', { name: 'Resize sidebar' });
  expect(separator).toHaveAttribute('aria-valuenow', '240');
  separator.focus();
  await user.keyboard('{ArrowRight}{ArrowRight}');
  expect(separator).toHaveAttribute('aria-valuenow', '272');
  expect(JSON.parse(localStorage.getItem('unicorn.sidebar.v1'))).toEqual({ width: 272, collapsed: false });
  await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
  expect(screen.queryByRole('separator', { name: 'Resize sidebar' })).not.toBeInTheDocument();
  const nav = screen.getByRole('navigation', { name: 'Switch resources' });
  expect(within(nav).getByRole('button', { name: 'Registers' })).toHaveTextContent('');
  view.unmount();
  mount();
  expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await user.click(within(screen.getByRole('navigation', { name: 'Switch resources' })).getByRole('button', { name: 'Registers' }));
  expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
  expect(screen.getByRole('link', { name: 'visits' })).toBeVisible();
  expect(screen.getByRole('separator', { name: 'Resize sidebar' })).toHaveAttribute('aria-valuenow', '272');
});
it('clamps keyboard and pointer resizing and keeps mobile navigation available', async () => {
  const user = userEvent.setup();
  const view = mount();
  const separator = screen.getByRole('separator', { name: 'Resize sidebar' });
  separator.focus();
  await user.keyboard('{Home}{ArrowLeft}');
  expect(separator).toHaveAttribute('aria-valuenow', '220');
  await user.keyboard('{End}{ArrowRight}');
  expect(separator).toHaveAttribute('aria-valuenow', '480');
  // Pointer capture preserves a drag even when its handle moves under the pointer.
  separator.setPointerCapture = vi.fn(); separator.hasPointerCapture = vi.fn(() => true); separator.releasePointerCapture = vi.fn();
  fireEvent.pointerDown(separator, { button: 0, clientX: 480, pointerId: 1 });
  fireEvent.pointerMove(separator, { clientX: 390, pointerId: 1 });
  fireEvent.pointerUp(separator, { pointerId: 1 });
  expect(separator).toHaveAttribute('aria-valuenow', '390');
  const previousWidth = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  fireEvent(window, new Event('resize'));
  expect(JSON.parse(localStorage.getItem('unicorn.sidebar.v1')).width).toBe(390);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
  view.unmount();
  window.matchMedia.mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  mount();
  await user.click(screen.getByRole('button', { name: 'Open resource menu' }));
  expect(screen.getByRole('presentation')).toBeInTheDocument();
});
