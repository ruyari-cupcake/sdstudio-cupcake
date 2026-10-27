import path from 'path';
import React, {
  act,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import { runGuardedClose } from '../../models/escapeGate';
import loadComponentFixture from '../testSupport/componentFixture';
import useLatestRef from '../useLatestRef';

interface ViewEntry {
  id: number;
  component: React.ReactNode;
  priority: number;
  ownsGenControl?: boolean;
  showToolbar?: boolean;
  onEscape?: () => void;
  dirty?: () => boolean;
}
interface Registry {
  registerView: (entry: ViewEntry) => void;
  unregisterView: (id: number) => void;
  updateView: (id: number, patch: Partial<Omit<ViewEntry, 'id'>>) => void;
}
function createFixture() {
  const context = createContext<Registry | undefined>(undefined);
  const counts = { views: 0, generation: 0, modals: 0 };
  const handles = new Set<() => void>();
  const push = jest.fn((close: () => void) => {
    handles.add(close);
    return { remove: () => handles.delete(close) };
  });
  const appState = {
    uiFloatViewMode: 'center',
    incrementFloatView: () => {
      counts.views += 1;
    },
    decrementFloatView: () => {
      counts.views -= 1;
    },
    incrementGenControlOverlay: () => {
      counts.generation += 1;
    },
    decrementGenControlOverlay: () => {
      counts.generation -= 1;
    },
    incrementModalOverlay: () => {
      counts.modals += 1;
    },
    decrementModalOverlay: () => {
      counts.modals -= 1;
    },
  };
  const bindings = {
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
    useLatestRef,
    memo,
    observer,
    createPortal,
    appState,
    document,
    isMobile: false,
    FloatViewContext: context,
    FLOAT_VIEW_WIDE_ANCHOR_ID: 'float-view-wide-anchor',
    FaTimes: 'span',
    backStackService: { push, init: jest.fn() },
    runGuardedClose,
    confirmDiscardChanges: () => Promise.resolve(true),
  };
  const Provider = loadComponentFixture<{ children: React.ReactNode }>(
    path.resolve(__dirname, '../FloatView.tsx'),
    'FloatViewProvider',
    bindings,
  );
  const View = loadComponentFixture<
    Omit<ViewEntry, 'id' | 'component'> & { children: React.ReactNode }
  >(path.resolve(__dirname, '../FloatView.tsx'), 'FloatView', {
    ...bindings,
    viewId: 0,
    useFloatView: () => useContext(context),
  });
  const Modal = loadComponentFixture<{
    isOpen: boolean;
    onClose: () => void;
    title: React.ReactNode;
    children: React.ReactNode;
  }>(path.resolve(__dirname, '../ModalOverlay.tsx'), 'ModalOverlay', {
    ...bindings,
    useGuardedClose: (_dirty: unknown, close: () => void) => close,
  });
  let registry!: Registry;
  function Capture() {
    registry = useContext(context)!;
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    Provider,
    View,
    Modal,
    Capture,
    counts,
    handles,
    push,
    container,
    root,
    get registry() {
      return registry;
    },
    dispose() {
      act(() => root.unmount());
      container.remove();
    },
  };
}
beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

test('a view ID owns one handle and counter, and updates transfer generation ownership', () => {
  const fixture = createFixture();
  const { Provider, Capture, counts, container, root } = fixture;
  try {
    act(() =>
      root.render(
        <Provider>
          <Capture />
        </Provider>,
      ),
    );
    const originalRegistry = fixture.registry;
    act(() =>
      fixture.registry.registerView({
        id: 7,
        priority: 1,
        component: <p>original</p>,
        ownsGenControl: false,
      }),
    );
    expect(counts).toEqual({ views: 1, generation: 0, modals: 0 });
    act(() =>
      fixture.registry.registerView({
        id: 7,
        priority: 2,
        component: <p>replacement</p>,
        ownsGenControl: true,
      }),
    );
    expect(counts).toEqual({ views: 1, generation: 1, modals: 0 });
    expect(fixture.registry).toBe(originalRegistry);
    expect(fixture.handles.size).toBe(1);
    expect(fixture.push).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('p').length).toBe(1);
    expect(container.querySelector('p')?.textContent).toBe('replacement');
    act(() => fixture.registry.updateView(7, { ownsGenControl: false }));
    expect(counts).toEqual({ views: 1, generation: 0, modals: 0 });
    act(() => {
      fixture.registry.unregisterView(7);
      fixture.registry.unregisterView(7);
      fixture.registry.unregisterView(999);
    });
    expect(counts).toEqual({ views: 0, generation: 0, modals: 0 });
    expect(fixture.handles.size).toBe(0);
    expect(container.querySelector('p')).toBeNull();
  } finally {
    fixture.dispose();
  }
});
test('provider teardown releases entries even when a caller omitted unregister', () => {
  const fixture = createFixture();
  const { Provider, Capture, root } = fixture;
  act(() =>
    root.render(
      <React.StrictMode>
        <Provider>
          <Capture />
        </Provider>
      </React.StrictMode>,
    ),
  );
  act(() => {
    fixture.registry.registerView({
      id: 1,
      priority: 0,
      component: null,
      ownsGenControl: true,
    });
    fixture.registry.registerView({ id: 2, priority: 0, component: null });
  });
  expect(fixture.counts).toEqual({ views: 2, generation: 1, modals: 0 });
  fixture.dispose();
  expect(fixture.counts).toEqual({ views: 0, generation: 0, modals: 0 });
  expect(fixture.handles.size).toBe(0);
});
test('mounted views update ownership and callbacks without moving their back-stack entry', () => {
  const fixture = createFixture();
  const { Provider, View, root } = fixture;
  const firstClose = jest.fn();
  const latestClose = jest.fn();
  try {
    act(() =>
      root.render(
        <React.StrictMode>
          <Provider>
            <View priority={0} onEscape={firstClose}>
              old
            </View>
          </Provider>
        </React.StrictMode>,
      ),
    );
    expect(fixture.counts.views).toBe(1);
    const viewHandle = [...fixture.handles][0];
    const registrations = fixture.push.mock.calls.length;
    act(() =>
      root.render(
        <React.StrictMode>
          <Provider>
            <View priority={3} ownsGenControl onEscape={latestClose}>
              new
            </View>
          </Provider>
        </React.StrictMode>,
      ),
    );
    expect(fixture.counts).toEqual({ views: 1, generation: 1, modals: 0 });
    expect(fixture.push).toHaveBeenCalledTimes(registrations);
    expect([...fixture.handles]).toEqual([viewHandle]);
    expect(fixture.container.textContent).toContain('new');
    act(() => viewHandle());
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);
    act(() => root.render(<Provider>{null}</Provider>));
    expect(fixture.counts).toEqual({ views: 0, generation: 0, modals: 0 });
    expect(fixture.handles.size).toBe(0);
  } finally {
    fixture.dispose();
  }
});
test('modal exposes its title and preserves exact backdrop and latest back-stack close behavior', () => {
  const fixture = createFixture();
  const { Modal, root, container } = fixture;
  const firstClose = jest.fn();
  const latestClose = jest.fn();
  try {
    act(() =>
      root.render(
        <Modal isOpen onClose={firstClose} title="Preferences">
          <p>content</p>
        </Modal>,
      ),
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const titleId = dialog?.getAttribute('aria-labelledby');
    expect(titleId && document.getElementById(titleId)?.textContent).toBe(
      'Preferences',
    );
    const back = [...fixture.handles][0];
    act(() =>
      root.render(
        <Modal isOpen onClose={latestClose} title="Preferences">
          <p>content</p>
        </Modal>,
      ),
    );
    expect(fixture.push).toHaveBeenCalledTimes(1);
    act(() => back());
    expect(firstClose).not.toHaveBeenCalled();
    expect(latestClose).toHaveBeenCalledTimes(1);
    const backdrop = container.firstElementChild!;
    const content = container.querySelector('p')!;
    act(() => {
      content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(latestClose).toHaveBeenCalledTimes(1);
    act(() => {
      backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(latestClose).toHaveBeenCalledTimes(2);
    act(() =>
      root.render(
        <Modal isOpen={false} onClose={latestClose} title="Preferences">
          {null}
        </Modal>,
      ),
    );
    expect(fixture.counts.modals).toBe(0);
    expect(fixture.handles.size).toBe(0);
  } finally {
    fixture.dispose();
  }
});
