import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import activateButtonFromKeyboard from '../keyboardButton';

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function renderAction() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClick = jest.fn();
  act(() =>
    root.render(
      <div
        role="button"
        tabIndex={0}
        onKeyDown={activateButtonFromKeyboard}
        onClick={onClick}
      >
        Action
        <button type="button">Nested action</button>
      </div>,
    ),
  );
  const action = container.firstElementChild as HTMLElement;
  return {
    action,
    onClick,
    dispose() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test.each(['Enter', ' '])(
  '%s activates exactly once and consumes the key',
  (key) => {
    const fixture = renderAction();
    try {
      const keyEvent = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => fixture.action.dispatchEvent(keyEvent));
      expect(fixture.onClick).toHaveBeenCalledTimes(1);
      expect(keyEvent.defaultPrevented).toBe(true);
      act(() =>
        fixture.action.dispatchEvent(
          new KeyboardEvent('keyup', { key, bubbles: true }),
        ),
      );
      expect(fixture.onClick).toHaveBeenCalledTimes(1);
    } finally {
      fixture.dispose();
    }
  },
);

test('a keyboard event from an interactive descendant retains its own ownership', () => {
  const fixture = renderAction();
  try {
    const keyEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => fixture.action.querySelector('button')!.dispatchEvent(keyEvent));
    expect(fixture.onClick).not.toHaveBeenCalled();
    expect(keyEvent.defaultPrevented).toBe(false);
  } finally {
    fixture.dispose();
  }
});

test('keyboard activation preserves all click modifier keys', () => {
  const fixture = renderAction();
  try {
    act(() =>
      fixture.action.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
          metaKey: true,
        }),
      ),
    );
    expect(fixture.onClick).toHaveBeenCalledTimes(1);
    const click = fixture.onClick.mock.calls[0][0] as React.MouseEvent;
    expect([
      click.ctrlKey,
      click.altKey,
      click.shiftKey,
      click.metaKey,
    ]).toEqual([true, true, true, true]);
  } finally {
    fixture.dispose();
  }
});

test('repeat, consumed, disabled and unrelated keys do not activate', () => {
  const fixture = renderAction();
  try {
    const repeated = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    const consumed = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    consumed.preventDefault();
    act(() => {
      fixture.action.dispatchEvent(repeated);
      fixture.action.dispatchEvent(consumed);
      fixture.action.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      );
      fixture.action.setAttribute('aria-disabled', 'true');
      fixture.action.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(fixture.onClick).not.toHaveBeenCalled();
    expect(repeated.defaultPrevented).toBe(false);
  } finally {
    fixture.dispose();
  }
});
