import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import Tooltip from '../Tooltip';

const label = '도움말 내용';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'elementFromPoint');
  jest.useRealTimers();
});

test('keyboard focus shows the description immediately and blur dismisses it', () => {
  render(
    <Tooltip content={label}>
      <button type="button">도움말</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole('button');
  fireEvent.focus(trigger);
  expect(screen.queryByText(label)).not.toBeNull();
  expect(screen.getByRole('tooltip').textContent).toBe(label);
  fireEvent.blur(trigger, { relatedTarget: document.body });
  expect(screen.queryByText(label)).toBeNull();
});

test('a late dialog covering a touched button dismisses its tooltip on the layout change', async () => {
  render(
    <Tooltip content={label}>
      <button type="button">도움말</button>
    </Tooltip>,
  );
  const trigger = screen.getByRole('button');
  let front: Element = trigger;
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => front,
  });
  trigger.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 30,
    bottom: 30,
    width: 30,
    height: 30,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  fireEvent.touchStart(trigger, { touches: [{ clientX: 10, clientY: 10 }] });
  fireEvent.touchEnd(trigger);
  // A dialog can finish loading after the old guessed 200/700 ms checks.
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.queryByText(label)).not.toBeNull();
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  try {
    await act(async () => {
      front = dialog;
      document.body.appendChild(dialog);
      await Promise.resolve();
    });
    expect(screen.queryByText(label)).toBeNull();
  } finally {
    dialog.remove();
  }
});
