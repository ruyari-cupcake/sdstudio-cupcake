import path from 'path';
import React, { act, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import loadFunctionFixture from '../testSupport/functionFixture';
import loadComponentFixture from '../testSupport/componentFixture';

const source = (name: string) => path.resolve(__dirname, `../${name}.tsx`);
const drain = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function sheetFixture(withAnimation = true) {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const element = document.createElement('div');
  const child = document.createElement('span');
  element.appendChild(child);
  element.getAnimations = () =>
    withAnimation
      ? [{ transitionProperty: 'transform', finished } as unknown as Animation]
      : [];
  const animRef = { current: null };
  const bindings = {
    sheetRef: { current: element },
    animRef,
    heights: { full: 600 },
    prevFullRef: { current: 600 },
    dragging: false,
    restTop: 200,
    dragOffset: 0,
    ready: true,
    visualTopRef: { current: 500 },
    TRANSITION: 'transform 0.2s ease',
    window: { setTimeout: jest.fn(), clearTimeout: jest.fn() },
  };
  const effect = loadFunctionFixture(
    source('MobilePromptSheet'),
    { hook: 'useLayoutEffect', contains: 'visualTopRef.current - restTop' },
    bindings,
  );
  const teardownEffect = loadFunctionFixture(
    source('MobilePromptSheet'),
    { hook: 'useEffect', contains: 'animRef.current' },
    bindings,
  );
  effect();
  return {
    element,
    child,
    finish,
    animRef,
    bindings,
    cleanup: teardownEffect() as () => void,
  };
}

test('a child transition cannot prematurely finish the prompt sheet transform', () => {
  const f = sheetFixture();
  f.child.dispatchEvent(new Event('transitionend', { bubbles: true }));
  expect(f.element.style.transform).toBe('translateY(0)');
  f.cleanup();
});

test('prompt sheet completion is owned by the real transform animation', async () => {
  const f = sheetFixture();
  f.finish();
  await drain();
  expect(f.element.style.transform).toBe('none');
  expect(f.bindings.window.setTimeout).not.toHaveBeenCalled();
  f.cleanup();
});

test('a sheet with no running animation releases its fixed-element transform immediately', () => {
  const f = sheetFixture(false);
  expect(f.element.style.transform).toBe('none');
  f.cleanup();
});

test('a prompt sheet removes its completion ownership on unmount', async () => {
  const f = sheetFixture();
  f.cleanup();
  f.element.style.transform = 'translateY(42px)';
  f.element.dispatchEvent(new Event('transitionend'));
  f.finish();
  await drain();
  expect(f.element.style.transform).toBe('translateY(42px)');
});

function keyboardFixture() {
  const events = new EventTarget();
  const callbacks: (() => void)[] = [];
  const refresh = jest.fn();
  const timers = {
    setTimeout: jest.fn((cb: () => void) => {
      callbacks.push(cb);
    }),
    clearTimeout: jest.fn(),
    visualViewport: undefined,
  };
  const effect = loadFunctionFixture(
    source('MobileKeyboardChip'),
    { hook: 'useEffect', contains: "document.addEventListener('focusin'" },
    {
      document: events,
      window: timers,
      refresh,
      holdRef: { current: null },
      queueMicrotask: (callback: () => void) => {
        callbacks.push(callback);
      },
    },
  );
  const cleanup = effect();
  const flush = () => callbacks.splice(0).forEach((cb) => cb());
  return { events, refresh, timers, cleanup, flush };
}

test('keyboard focus work cannot publish after the chip is unmounted', () => {
  const f = keyboardFixture();
  f.events.dispatchEvent(new Event('focusin'));
  f.cleanup();
  f.flush();
  expect(f.refresh).not.toHaveBeenCalled();
});

test('one focus transfer schedules one owned update after the focus events settle', () => {
  const f = keyboardFixture();
  f.events.dispatchEvent(new Event('focusout'));
  f.events.dispatchEvent(new Event('focusin'));
  expect(f.refresh).not.toHaveBeenCalled();
  f.flush();
  expect(f.refresh).toHaveBeenCalledTimes(1);
  expect(f.timers.setTimeout).not.toHaveBeenCalled();
  f.cleanup();
});

function dragFixture() {
  const events = Object.assign(new EventTarget(), { innerWidth: 1000 });
  const applyAndRemeasure = jest.fn();
  const setDragging = jest.fn();
  const target = Object.assign(new EventTarget(), {
    setPointerCapture: jest.fn(),
    hasPointerCapture: jest.fn(() => true),
    releasePointerCapture: jest.fn(),
  });
  const dragCleanupRef = { current: null as (() => void) | null };
  const start = loadFunctionFixture(
    source('EditModeShell'),
    { name: 'startPanelDrag' },
    {
      useCallback: (callback: unknown) => callback,
      window: events,
      DRAG_THRESHOLD: 8,
      applyAndRemeasure,
      setDragging,
      setHoverSide: jest.fn(),
      dragCleanupRef,
      SIDE_KEY: { project: 'projectSide' },
      currentSide: () => 'left',
    },
  );
  start('project', {
    button: 0,
    pointerId: 7,
    clientX: 100,
    clientY: 100,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    currentTarget: target,
  });
  const dispatch = (name: string, pointerId: number, clientX = 800) =>
    events.dispatchEvent(
      Object.assign(new Event(name), { pointerId, clientX, clientY: 100 }),
    );
  return { dispatch, applyAndRemeasure, setDragging };
}

test('a cancelled panel gesture cannot later commit a layout change', () => {
  const f = dragFixture();
  f.dispatch('pointercancel', 7);
  f.dispatch('pointerup', 7);
  expect(f.applyAndRemeasure).not.toHaveBeenCalled();
});

test('a second pointer cannot move or commit the first panel gesture', () => {
  const f = dragFixture();
  f.dispatch('pointermove', 8);
  f.dispatch('pointerup', 8);
  expect(f.applyAndRemeasure).not.toHaveBeenCalled();
  expect(f.setDragging).not.toHaveBeenCalledWith('project');
  f.dispatch('pointerup', 7);
  expect(f.applyAndRemeasure).toHaveBeenCalledTimes(1);
});

test('history resize teardown releases document listeners and restores previous body styles', () => {
  const appState = {
    historyPanelCollapsed: false,
    historyPanelWidth: 300,
    uiLayoutTemplate: 'default',
    uiLayoutSlots: {},
    setHistoryPanelWidth: jest.fn(),
    toggleHistoryPanel: jest.fn(),
  };
  const Panel = loadComponentFixture(
    source('ImageHistory'),
    'ImageHistoryPanel',
    {
      React,
      useEffect,
      useRef,
      useState,
      observer: (component: unknown) => component,
      appState,
      isMobile: false,
      resolveLayout: () => ({ historySide: 'right' }),
      window,
      document,
      Tooltip: ({ children }: { children: React.ReactNode }) => children,
      HistoryColumnsToggle: () => null,
      HistoryList: () => null,
      FaChevronLeft: 'span',
      FaChevronRight: 'span',
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const oldCursor = document.body.style.cursor;
  const oldSelect = document.body.style.userSelect;
  document.body.style.cursor = 'crosshair';
  document.body.style.userSelect = 'text';
  let unmounted = false;
  try {
    act(() => root.render(<Panel />));
    const handle = container.querySelector('.zone-splitter-bar')!;
    act(() =>
      handle.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 400, button: 0 }),
      ),
    );
    act(() => root.unmount());
    unmounted = true;
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }));
    expect(appState.setHistoryPanelWidth).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
  } finally {
    document.dispatchEvent(new MouseEvent('mouseup'));
    if (!unmounted) act(() => root.unmount());
    document.body.style.cursor = oldCursor;
    document.body.style.userSelect = oldSelect;
    container.remove();
  }
});
