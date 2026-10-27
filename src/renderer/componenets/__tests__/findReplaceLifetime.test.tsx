import path from 'path';
import React, {
  act,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { computed, observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import loadComponentFixture from '../testSupport/componentFixture';
import {
  deferred,
  flushMicrotasks,
} from '../../models/testSupport/completionMethodHarness';

const source = path.resolve(__dirname, '../FindReplaceDialog.tsx');
function fixture(name: string, searchTags = jest.fn()) {
  const appState = observable({
    curSession: {
      name: 'session',
      scenes: new Map([['scene', { name: 'old-scene', slots: [] }]]),
      inpaints: new Map(),
    },
    findReplaceOpen: true,
    closeFindReplace: () => {},
  });
  const View = loadComponentFixture<Record<string, unknown>>(source, name, {
    React,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    observer,
    computed,
    setTimeout,
    clearTimeout,
    window,
    document,
    appState,
    backend: { searchTags },
    collectResults: () => [],
    variantKey: (value: string) => `inpaint:${value}`,
    sceneKeyLabel: (value: string) => value,
    FaSearch: 'span',
    FaExchangeAlt: 'span',
    FaPlus: 'span',
    HighlightMatch: () => null,
    ModalOverlay: ({ children }: React.PropsWithChildren) => children,
    FindTab: ({
      searchInputRef,
    }: {
      searchInputRef: React.RefObject<HTMLInputElement>;
    }) => <input ref={searchInputRef} data-search="" />,
    InsertTab: () => null,
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(<View searchInputRef={React.createRef<HTMLInputElement>()} />),
  );
  return {
    container,
    appState,
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function change(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

test.each(['FindTab', 'InsertTab'])(
  '%s observes scene renames without a map-size change',
  (name) => {
    const f = fixture(name);
    try {
      expect(f.container.textContent).toContain('old-scene');
      act(() =>
        runInAction(() => {
          f.appState.curSession.scenes.get('scene')!.name = 'new-scene';
        }),
      );
      expect(f.container.textContent).toContain('new-scene');
      expect(f.container.textContent).not.toContain('old-scene');
    } finally {
      f.dispose();
    }
  },
);

test('clearing the insertion query invalidates an outstanding tag result', async () => {
  const pending = deferred<Array<{ word: string }>>();
  const searchTags = jest.fn(() => pending.promise);
  const f = fixture('InsertTab', searchTags);
  try {
    const input = f.container.querySelector<HTMLInputElement>(
      'input[placeholder="태그 입력 (예: 1girl, masterpiece)"]',
    )!;
    change(input, 'old');
    expect(searchTags).toHaveBeenCalledWith('old');
    change(input, '');
    await act(async () => {
      pending.resolve([{ word: 'old-tag' }]);
      await flushMicrotasks();
    });
    expect(f.container.textContent).not.toContain('old-tag');
  } finally {
    f.dispose();
  }
});

test('the search dialog focuses its committed input without a delayed callback', () => {
  const f = fixture('FindReplaceDialog');
  try {
    expect(document.activeElement).toBe(
      f.container.querySelector('[data-search]'),
    );
  } finally {
    f.dispose();
  }
});
