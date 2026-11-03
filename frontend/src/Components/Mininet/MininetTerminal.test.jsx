import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MininetTerminal from './MininetTerminal';

let terminal;
vi.mock('../../Contexts/TerminalContext', () => ({ useTerminal: () => terminal }));
vi.mock('react-terminal-ui', () => ({ ColorMode: { Dark: 1 }, TerminalOutput: ({ children }) => <div>{children}</div>,
  default: ({ children }) => <div className="react-terminal">{children}</div> }));
beforeEach(() => {
  terminal = { terminalTargets: [{ name: 'h1', type: 'Host' }], terminalLineData: { h1: ['greeting'] },
    activeTerminal: 'h1', setActiveTerminal: vi.fn(), handleInput: vi.fn(), handleInterrupt: vi.fn(), connected: true };
});
function setup() {
  const view = render(<MininetTerminal />);
  const viewport = view.container.querySelector('.react-terminal');
  let height = 100, top = 0;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 100 }, scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: value => { top = Math.min(Math.max(0, value), height - 100); } },
  });
  return { viewport, append(value, size) {
    height = size;
    terminal = { ...terminal, terminalLineData: { h1: [...terminal.terminalLineData.h1, value] } };
    view.rerender(<MininetTerminal />);
  } };
}
it('follows output continuously while at the bottom without scrolling the document', () => {
  const { viewport, append } = setup();
  const documentScroll = document.documentElement.scrollTop;
  append('ping reply 1', 500); expect(viewport.scrollTop).toBe(400);
  append('ping reply 2', 700); expect(viewport.scrollTop).toBe(600);
  expect(screen.queryByRole('button', { name: 'Jump to latest output' })).not.toBeInTheDocument();
  expect(document.documentElement.scrollTop).toBe(documentScroll);
});
it('pauses while reading earlier lines and resumes from the jump button or manual scrolling', async () => {
  const user = userEvent.setup();
  const { viewport, append } = setup();
  append('ping reply 1', 500);
  fireEvent.scroll(viewport, { target: { scrollTop: 100 } });
  expect(screen.getByRole('button', { name: 'Jump to latest output' })).toBeVisible();
  append('ping reply 2', 700); expect(viewport.scrollTop).toBe(100);
  await user.click(screen.getByRole('button', { name: 'Jump to latest output' }));
  expect(viewport.scrollTop).toBe(600);
  append('ping reply 3', 900); expect(viewport.scrollTop).toBe(800);
  fireEvent.scroll(viewport, { target: { scrollTop: 200 } });
  fireEvent.scroll(viewport, { target: { scrollTop: 800 } });
  append('ping reply 4', 1000); expect(viewport.scrollTop).toBe(900);
  expect(screen.queryByRole('button', { name: 'Jump to latest output' })).not.toBeInTheDocument();
});

it('preserves a manual scroll even when output arrives before its scroll event', () => {
  const { viewport, append } = setup();
  append('ping reply 1', 500);
  viewport.scrollTop = 100;
  append('ping reply 2', 700);
  expect(viewport.scrollTop).toBe(100);
  expect(screen.getByRole('button', { name: 'Jump to latest output' })).toBeVisible();
});
