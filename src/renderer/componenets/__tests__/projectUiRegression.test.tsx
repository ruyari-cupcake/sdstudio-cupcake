import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import React, {
  act,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import loadComponentFixture from '../testSupport/componentFixture';
import loadEffectFixture from '../testSupport/effectFixture';

const browserFile = path.resolve(__dirname, '../ProjectBrowser.tsx');
const drawerFile = path.resolve(__dirname, '../ProjectDrawer.tsx');
const recentFile = path.resolve(__dirname, '../recentProjects.ts');
const transitionFile = path.resolve(__dirname, '../useTransitionPresence.ts');

function loadBinding<T>(
  filename: string,
  name: string,
  bindings: Record<string, unknown>,
): T {
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    )
      matches.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (matches.length !== 1)
    throw new Error(`Expected one ${name} definition, found ${matches.length}`);
  const compiled = ts.transpileModule(
    `const fixtureValue = ${matches[0].getText(source)}; fixtureValue;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
      fileName: filename,
    },
  ).outputText;
  return new vm.Script(compiled, { filename }).runInNewContext(bindings) as T;
}

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

function mount(element: React.ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    render: (next: React.ReactNode) => act(() => root.render(next)),
    dispose: () => {
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
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test.each(['null', '{}', '42', '"project"'])(
  'recent-project history treats valid JSON %s with the wrong shape as an empty preference',
  (raw) => {
    const getRecentProjects = loadComponentFixture(
      fs.existsSync(recentFile) ? recentFile : browserFile,
      'getRecentProjects',
      {
        localStorage: { getItem: () => raw },
        RECENT_KEY: 'fixture',
        RECENT_MAX: 5,
      },
    ) as unknown as () => string[];
    expect(getRecentProjects()).toEqual([]);
  },
);

test('recent-project history keeps unique project names and discards non-name entries', () => {
  const getRecentProjects = loadComponentFixture(
    fs.existsSync(recentFile) ? recentFile : browserFile,
    'getRecentProjects',
    {
      localStorage: {
        getItem: () => '["a",null,5,"b","a",{},"c","d","e","f"]',
      },
      RECENT_KEY: 'fixture',
      RECENT_MAX: 5,
    },
  ) as unknown as () => string[];
  expect(getRecentProjects()).toEqual(['a', 'b', 'c', 'd', 'e']);
});

function thumbnailFixture(
  fetchImageSmall: (name: string) => Promise<string | undefined>,
) {
  const resolveThumbnail = jest.fn().mockResolvedValue(undefined);
  const Thumbnail = loadComponentFixture<{ name: string }>(
    browserFile,
    'ProjectThumbnail',
    {
      useState,
      useEffect,
      console,
      projectPath: (_category: string, name: string) => name,
      imageService: { fetchImageSmall },
      sessionService: {
        getThumbnailRef: () => ({ scene: 'scene', image: 'image' }),
        resolveThumbnail,
        setThumbnailRef: jest.fn(),
        clearThumbnailRef: jest.fn(),
      },
    },
  );
  const dom = mount(<Thumbnail name="first" />);
  return {
    ...dom,
    resolveThumbnail,
    change: (name: string) => dom.render(<Thumbnail name={name} />),
  };
}

test('changing the project owner clears its previous thumbnail before the new preview resolves', async () => {
  const first = deferred<string>();
  const next = deferred<string | undefined>();
  const f = thumbnailFixture((name) =>
    name === 'first' ? first.promise : next.promise,
  );
  try {
    await act(async () => {
      first.resolve('data:image/png;base64,first');
      await first.promise;
    });
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,first',
    );
    f.change('next');
    expect(f.container.querySelector('img')).toBeNull();
    await act(async () => {
      next.resolve(undefined);
      await next.promise;
    });
    expect(f.container.querySelector('img')).toBeNull();
  } finally {
    f.dispose();
  }
});

test('a cancelled cached-thumbnail request cannot start loading the entire project afterwards', async () => {
  const cached = deferred<string | undefined>();
  const f = thumbnailFixture(() => cached.promise);
  f.dispose();
  await act(async () => {
    cached.resolve(undefined);
    await cached.promise;
  });
  expect(f.resolveThumbnail).not.toHaveBeenCalled();
});

const presentationBindings = {
  observer,
  Tooltip: ({ children }: React.PropsWithChildren) => children,
  ProjectThumbnail: () => null,
  ActionIcon: 'span',
  FaStar: 'span',
  FaCheck: 'span',
  FaTimes: 'span',
  FaPen: 'span',
  FaEllipsisV: 'span',
  FaWindowRestore: 'span',
  FaFolder: 'span',
  FaFilm: 'span',
  FaPalette: 'span',
  FaPlus: 'span',
  activateButtonFromKeyboard: jest.fn(),
  withAlpha: (value: string) => value,
  backend: { openNewWindow: jest.fn() },
};

test('project card selection has a native button and its secondary actions stay separate', () => {
  const select = jest.fn();
  const favorite = jest.fn();
  const Card = loadComponentFixture<Record<string, unknown>>(
    browserFile,
    'ProjectCard',
    { ...presentationBindings, isMobile: false },
  );
  const f = mount(
    <Card
      name="sample"
      isFav={false}
      isActive={false}
      isSelected={false}
      onSelect={select}
      onToggleFav={favorite}
      onMove={jest.fn()}
    />,
  );
  try {
    const primary = f.container.querySelector(
      'button[aria-label="sample 프로젝트 선택"]',
    );
    expect(primary).not.toBeNull();
    expect(
      f.container.querySelector('button button, button [role="button"]'),
    ).toBeNull();
    act(() =>
      (
        f.container.querySelector(
          '[aria-label="즐겨찾기"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(favorite).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    act(() => (primary as HTMLButtonElement).click());
    expect(select).toHaveBeenCalledTimes(1);
  } finally {
    f.dispose();
  }
});

test('folder navigation keeps clone and rename as independent native actions', () => {
  const select = jest.fn();
  const clone = jest.fn();
  const Nav = loadComponentFixture<Record<string, unknown>>(
    browserFile,
    'NavItem',
    { ...presentationBindings, isMobile: false },
  );
  const f = mount(
    <Nav
      active={false}
      label="folder"
      onClick={select}
      onClone={clone}
      onRename={jest.fn()}
    />,
  );
  try {
    expect(
      f.container.querySelector('button button, button [role="button"]'),
    ).toBeNull();
    const cloneButton = f.container.querySelector(
      'button[aria-label="폴더 복제"]',
    );
    expect(cloneButton).not.toBeNull();
    act(() => (cloneButton as HTMLButtonElement).click());
    expect(clone).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

test('project drawer rows preserve native drag ownership while separating favorite and menu buttons', () => {
  const select = jest.fn();
  const favorite = jest.fn();
  const drag = jest.fn();
  const Row = loadComponentFixture<Record<string, unknown>>(
    drawerFile,
    'ProjectRow',
    {
      ...presentationBindings,
      isMobile: true,
      appState: { curSession: { name: 'sample' } },
      sessionService: { isFavorite: () => false, toggleFavorite: favorite },
      templateService: {
        isSceneTemplate: () => true,
        getInheritedApplication: () => undefined,
      },
      projectTemplateService: { get: jest.fn() },
      DEFAULT_FOLDER_COLOR: '#000000',
    },
  );
  const f = mount(
    <Row
      name="sample"
      dndEnabled
      onSelect={select}
      onDragStart={drag}
      onDragEnd={jest.fn()}
      onMenu={jest.fn()}
      queueRemain={2}
    />,
  );
  try {
    expect(
      f.container.querySelector('button button, button [role="button"]'),
    ).toBeNull();
    const primary = f.container.querySelector(
      'button[aria-label="sample 프로젝트 선택"]',
    );
    expect(primary).not.toBeNull();
    act(() =>
      (
        f.container.querySelector(
          'button[aria-label="즐겨찾기"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(favorite).toHaveBeenCalledWith('sample');
    expect(select).not.toHaveBeenCalled();
    const source = f.container.querySelector('[data-drag-name="sample"]');
    expect(source?.getAttribute('draggable')).toBe('true');
    act(() => source?.dispatchEvent(new Event('dragstart', { bubbles: true })));
    expect(drag).toHaveBeenCalledTimes(1);
  } finally {
    f.dispose();
  }
});

function bulkFixture(
  filename: string,
  moveToFolder: (name: string, folder: string | null) => Promise<void>,
) {
  const selected = new Set(['ok', 'failed']);
  const selectedRef = { current: selected };
  let current = selected;
  const exitSelect = jest.fn();
  const pushMessage = jest.fn();
  const bulkMove = loadBinding<() => Promise<void>>(filename, 'bulkMove', {
    selected,
    selectedRef,
    exitSelect,
    refresh: jest.fn(),
    folders: ['target'],
    useCallback: (callback: unknown) => callback,
    setSelected: (update: (value: Set<string>) => Set<string>) => {
      current = update(current);
      selectedRef.current = current;
    },
    sessionService: { moveToFolder, getOrderedFolders: () => ['target'] },
    appState: { pushDialogAsync: async () => 'target', pushMessage },
  });
  return {
    bulkMove,
    exitSelect,
    pushMessage,
    selected: () => [...current],
    changeSelection: () => {
      current = new Set(['new']);
      selectedRef.current = current;
    },
  };
}

test.each([browserFile, drawerFile])(
  '%s reports partial moves honestly and retains failed selections',
  async (filename) => {
    const f = bulkFixture(filename, async (name) => {
      if (name === 'failed') throw new Error('disk unavailable');
    });
    await f.bulkMove();
    expect(f.exitSelect).not.toHaveBeenCalled();
    expect(f.selected()).toEqual(['failed']);
    expect(f.pushMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('1개는 이동하지 못했습니다.'),
      'error',
    );
    expect(f.pushMessage.mock.calls.at(-1)?.[0]).toContain(
      'failed: Error: disk unavailable',
    );
  },
);

test.each([browserFile, drawerFile])(
  '%s does not clear a newer selection when an earlier move completes',
  async (filename) => {
    const pending = deferred<void>();
    const f = bulkFixture(filename, () => pending.promise);
    const moving = f.bulkMove();
    await Promise.resolve();
    f.changeSelection();
    pending.resolve();
    await moving;
    expect(f.exitSelect).not.toHaveBeenCalled();
    expect(f.selected()).toEqual(['new']);
    expect(f.pushMessage).toHaveBeenLastCalledWith(
      '2개 프로젝트를 이동했습니다.',
      'info',
    );
  },
);

type Presence = {
  render: boolean;
  shown: boolean;
  panelRef: React.RefObject<HTMLDivElement>;
};

function useLegacyPresence(open: boolean): Presence {
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const effect = React.useMemo(
    () =>
      loadEffectFixture(drawerFile, 'setTimeout(() => setRender(false), 260)', {
        open,
        setRender,
        setShown,
        setTimeout,
        clearTimeout,
        requestAnimationFrame,
        cancelAnimationFrame,
      }),
    [open],
  );
  useEffect(effect, [effect]);
  return { render, shown, panelRef };
}

function transitionFixture(
  animations: Array<{ transitionProperty: string; finished: Promise<void> }>,
) {
  jest.useFakeTimers();
  const previous = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'getAnimations',
  );
  Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
    configurable: true,
    value: () => animations,
  });
  const usePresence = fs.existsSync(transitionFile)
    ? (loadComponentFixture(transitionFile, 'useTransitionPresence', {
        useLayoutEffect,
        useRef,
        useState,
        requestAnimationFrame,
        cancelAnimationFrame,
      }) as unknown as (open: boolean) => Presence)
    : useLegacyPresence;
  function Panel({ open }: { open: boolean }) {
    const presence = usePresence(open);
    return presence.render ? (
      <div ref={presence.panelRef} data-shown={presence.shown} />
    ) : null;
  }
  const dom = mount(<Panel open />);
  return {
    container: dom.container,
    close: () => dom.render(<Panel open={false} />),
    reopen: () => dom.render(<Panel open />),
    dispose: () => {
      dom.dispose();
      if (previous)
        Object.defineProperty(HTMLElement.prototype, 'getAnimations', previous);
      else
        delete (HTMLElement.prototype as { getAnimations?: unknown })
          .getAnimations;
    },
  };
}

test('a panel remains mounted until its actual transform transition finishes, regardless of elapsed time', async () => {
  const animation = deferred<void>();
  const f = transitionFixture([
    { transitionProperty: 'transform', finished: animation.promise },
  ]);
  try {
    f.close();
    act(() => jest.advanceTimersByTime(1000));
    expect(f.container.firstElementChild).not.toBeNull();
    await act(async () => {
      animation.resolve();
      await animation.promise;
    });
    expect(f.container.firstElementChild).toBeNull();
  } finally {
    f.dispose();
  }
});

test('a panel with no active transition unmounts immediately without a guessed closing delay', () => {
  const f = transitionFixture([]);
  try {
    f.close();
    expect(f.container.firstElementChild).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    f.dispose();
  }
});

test('an interrupted close cannot unmount a panel that has reopened', async () => {
  const animation = deferred<void>();
  const f = transitionFixture([
    { transitionProperty: 'transform', finished: animation.promise },
  ]);
  try {
    f.close();
    f.reopen();
    await act(async () => {
      animation.resolve();
      await animation.promise;
    });
    expect(f.container.firstElementChild).not.toBeNull();
  } finally {
    f.dispose();
  }
});

function touchFixture() {
  jest.useFakeTimers();
  const source = document.createElement('button');
  source.setAttribute('data-drag-type', 'project');
  source.setAttribute('data-drag-name', 'sample');
  document.body.appendChild(source);
  const effect = loadEffectFixture(drawerFile, 'let suppressClick = false', {
    render: true,
    isMobile: true,
    window,
    document,
    navigator,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: jest.fn(() => 1),
    cancelAnimationFrame: jest.fn(),
    listScrollRef: { current: null },
    sessionService: { folderLeafName: (name: string) => name },
    touchApiRef: {
      current: {
        setDrag: jest.fn(),
        setDropTarget: jest.fn(),
        setNestTarget: jest.fn(),
      },
    },
  });
  const cleanup = effect();
  const touch = (
    name: string,
    touches: Array<{ clientX: number; clientY: number }>,
  ) => {
    const event = new Event(name, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: touches });
    source.dispatchEvent(event);
  };
  touch('touchstart', [{ clientX: 10, clientY: 10 }]);
  jest.advanceTimersByTime(320);
  touch('touchend', []);
  return {
    source,
    click: (detail: number) => {
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        detail,
      });
      source.dispatchEvent(event);
      return event;
    },
    dispose: () => {
      cleanup?.();
      source.remove();
    },
  };
}

test('touch drag consumes one compatibility click and releases a new pointer gesture immediately', () => {
  const f = touchFixture();
  try {
    expect(f.click(1).defaultPrevented).toBe(true);
    f.source.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(f.click(1).defaultPrevented).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    f.dispose();
  }
});

test('touch drag does not suppress keyboard activation or leave a completion timer after unmount', () => {
  const f = touchFixture();
  try {
    expect(f.click(0).defaultPrevented).toBe(false);
  } finally {
    f.dispose();
  }
  expect(jest.getTimerCount()).toBe(0);
});

test('native project drag waits for the browser drag phase, never an elapsed timer', () => {
  jest.useFakeTimers();
  const setDrag = jest.fn();
  const pendingNativeDragRef = { current: null };
  const bindings = {
    setDrag,
    pendingNativeDragRef,
    dragStartTimerRef: { current: null },
    setTimeout,
    clearTimeout,
    queueSnapshot: { remains: {}, running: null },
    dndEnabled: true,
    selectMode: false,
    drag: null,
    selected: new Set(),
    editingProject: null,
    editProjectValue: '',
    setEditProjectValue: jest.fn(),
    commitProjectRename: jest.fn(),
    cancelProjectRename: jest.fn(),
    setDropTarget: jest.fn(),
    setNestTarget: jest.fn(),
    toggleSelect: jest.fn(),
    selectProject: jest.fn(),
    setToolbar: jest.fn(),
    openProjectMenu: jest.fn(),
    window,
  };
  const commitNativeDrag = fs
    .readFileSync(drawerFile, 'utf8')
    .includes('const commitNativeDrag')
    ? loadBinding<() => void>(drawerFile, 'commitNativeDrag', bindings)
    : undefined;
  const rowProps = loadBinding<
    (name: string) => {
      onDragStart: (event: unknown) => void;
      onDrag?: () => void;
      onDragEnd: () => void;
    }
  >(drawerFile, 'rowProps', { ...bindings, commitNativeDrag });
  const row = rowProps('sample');
  row.onDragStart({ dataTransfer: {}, stopPropagation: jest.fn() });
  jest.advanceTimersByTime(1000);
  expect(setDrag).not.toHaveBeenCalled();
  row.onDrag?.();
  expect(setDrag).toHaveBeenLastCalledWith({ type: 'project', name: 'sample' });
  row.onDragEnd();
  expect(setDrag).toHaveBeenLastCalledWith(null);
  expect(jest.getTimerCount()).toBe(0);
});
