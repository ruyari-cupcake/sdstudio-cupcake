import fs from 'fs';
import path from 'path';
import React, {
  act,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import { action, observable, runInAction } from 'mobx';
import loadComponentFixture from '../testSupport/componentFixture';

const source = path.resolve(__dirname, '../SceneEditor.tsx');
let nextId = 0;
const uuidv4 = () => `fixture-${++nextId}`;
const text = fs.readFileSync(source, 'utf8');
const keyFunction = text.includes('function promptSlotKey')
  ? loadComponentFixture(source, 'promptSlotKey', {
      promptSlotKeys: new WeakMap(),
      uuidv4,
    })
  : undefined;
const SlotEditor = loadComponentFixture<Record<string, unknown>>(
  source,
  'SlotEditor',
  {
    observer,
    action,
    runInAction,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    setTimeout,
    clearTimeout,
    uuidv4,
    promptSlotKey: keyFunction,
    ResizeObserver: class {
      observe = jest.fn();

      disconnect = jest.fn();
    },
    PromptPiece: { fromJSON: (value: unknown) => value },
    appState: { pushMessage: jest.fn() },
    isMobile: true,
    combinationCount: () => 3,
    FloatView: ({ children }: React.PropsWithChildren) => children,
    Tooltip: ({ children }: React.PropsWithChildren) => children,
    CombinationList: () => null,
    SlotPiece: ({ piece }: { piece: { id: string; prompt: string } }) => (
      <textarea aria-label={piece.id} defaultValue={piece.prompt} />
    ),
    FaPlus: 'span',
    FaQuestionCircle: 'span',
  },
);

let widthDescriptor: PropertyDescriptor | undefined;
let scrollDescriptor: PropertyDescriptor | undefined;
const scroll = jest.fn();
beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  jest.useFakeTimers();
  scroll.mockClear();
  widthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth',
  );
  scrollDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollTo',
  );
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 320,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: scroll,
  });
});
afterEach(() => {
  if (widthDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      'clientWidth',
      widthDescriptor,
    );
  else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  if (scrollDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollDescriptor);
  else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  jest.clearAllTimers();
  jest.useRealTimers();
});

function fixture() {
  const scene = observable({
    slots: ['first', 'middle', 'last'].map((id) => [
      { id, prompt: id, characterPrompts: [], enabled: true },
    ]),
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<SlotEditor scene={scene} />));
  return {
    scene,
    container,
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test('adding a column scrolls to the committed new page without advancing a clock', () => {
  const f = fixture();
  try {
    act(() =>
      (
        f.container.querySelector('[aria-label="열 추가"]') as HTMLButtonElement
      ).click(),
    );
    expect(f.container.querySelectorAll('[data-slot-page]')).toHaveLength(4);
    expect(scroll).toHaveBeenLastCalledWith({
      left: 3 * 320,
      behavior: 'smooth',
    });
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    f.dispose();
  }
});

test('removing a preceding column preserves the surviving editor DOM and its draft', () => {
  const f = fixture();
  try {
    const lastPage = f.container.querySelector('[data-slot-page="3"]');
    const draft = lastPage?.querySelector('textarea') as HTMLTextAreaElement;
    draft.value = 'uncommitted caret-owned draft';
    act(() =>
      runInAction(() => {
        f.scene.slots.splice(1, 1);
      }),
    );
    expect(f.container.querySelector('[data-slot-page="2"]')).toBe(lastPage);
    expect(f.container.querySelector('[aria-label="last"]')).toBe(draft);
    expect(draft.value).toBe('uncommitted caret-owned draft');
  } finally {
    f.dispose();
  }
});
