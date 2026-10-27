import path from 'path';
import loadFunctionFixture from '../testSupport/functionFixture';

const source = path.resolve(__dirname, '../PromptEditTextArea.tsx');
const drain = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function deferred<T>() {
  let complete!: (value: T) => void;
  let fail!: (reason: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, resolve: complete, reject: fail };
}

function suggestions() {
  const search = deferred<unknown[]>();
  const coords = deferred<number[]>();
  const mountedRef = { current: true };
  const cntRef = { current: 0 };
  const editorRef = {
    current: {
      getCaretCoords: jest.fn(() => coords.promise),
      onOpenAutoComplete: jest.fn(),
      onCloseAutoComplete: jest.fn(),
    },
  };
  const setTags = jest.fn();
  const warn = jest.fn();
  const bindings = {
    mountedRef,
    cntRef,
    editorRef,
    setTags,
    setSelectedTag: jest.fn(),
    setId: jest.fn(),
    setClientX: jest.fn(),
    setClientY: jest.fn(),
    setCurWord: jest.fn(),
    backend: {
      searchTags: () => search.promise,
      searchPieces: () => search.promise,
    },
    trimAutocompleteWord: (word: string) => word,
    autocompleteTagCategory: () => undefined,
    highlightPrompt: () => 'highlighted',
    curSession: {},
    lineHighlight: false,
    console: { warn },
  };
  const close = loadFunctionFixture(
    source,
    { name: 'closeAutoComplete' },
    bindings,
  );
  const highlight = loadFunctionFixture(
    source,
    { name: 'highlight' },
    {
      ...bindings,
      closeAutoComplete: close,
    },
  );
  return { ...bindings, search, coords, close, highlight, warn };
}

test('clearing the prompt invalidates a pending suggestion request', async () => {
  const f = suggestions();
  f.highlight('cat', 'cat', true);
  f.highlight('', '', true);
  f.setTags.mockClear();
  f.search.resolve([{ word: 'cat' }]);
  f.coords.resolve([10, 20]);
  await drain();
  expect(f.setTags).not.toHaveBeenCalled();
  expect(f.editorRef.current.onOpenAutoComplete).not.toHaveBeenCalled();
});

test('closing autocomplete while caret measurement is pending cannot reopen it', async () => {
  const f = suggestions();
  f.highlight('cat', 'cat', true);
  f.search.resolve([{ word: 'cat' }]);
  await drain();
  expect(f.editorRef.current.getCaretCoords).toHaveBeenCalledTimes(1);
  f.close();
  f.setTags.mockClear();
  f.coords.resolve([10, 20]);
  await drain();
  expect(f.setTags).not.toHaveBeenCalled();
  expect(f.editorRef.current.onOpenAutoComplete).not.toHaveBeenCalled();
});

test('suggestion failure terminates its owned promise and clears the current popup', async () => {
  const f = suggestions();
  const registered = jest.fn();
  // Observe the actual terminal catch installed by production without producing an
  // intentionally unhandled rejection in the RED runner itself.
  const failure = new Error('tag index unavailable');
  const chain = { catch: registered };
  const failingSearch = { then: () => chain };
  const highlight = loadFunctionFixture(
    source,
    { name: 'highlight' },
    {
      ...f,
      closeAutoComplete: f.close,
      backend: { searchTags: () => failingSearch },
      trimAutocompleteWord: (word: string) => word,
      autocompleteTagCategory: () => undefined,
      highlightPrompt: () => '',
      curSession: {},
      lineHighlight: false,
      console: { warn: f.warn },
    },
  );
  highlight('cat', 'cat', true);
  expect(registered).toHaveBeenCalledTimes(1);
  registered.mock.calls[0][0](failure);
  expect(f.setTags).toHaveBeenLastCalledWith([]);
  expect(f.warn).toHaveBeenCalledWith(expect.any(String), failure);
});

test('teardown invalidates a running artist lookup as well as its pending timer', async () => {
  jest.useFakeTimers();
  const lookup = deferred<boolean>();
  const mountedRef = { current: true };
  const caretSeq = { current: 0 };
  const caretTimer = { current: null as number | null };
  const setCaretArtist = jest.fn();
  const bindings = {
    mountedRef,
    caretSeq,
    caretTimer,
    setCaretArtist,
    cntRef: { current: 0 },
    editorRef: { current: { getCaretSegment: () => 'artist' } },
    artistNameOfSegment: () => ({ name: 'artist', prefixed: false }),
    caretArtistLookup: () => lookup.promise,
    rootRef: { current: document.createElement('div') },
    document,
    window,
    console,
  };
  const refresh = loadFunctionFixture(
    source,
    { name: 'refreshCaretArtist' },
    bindings,
  );
  const effect = loadFunctionFixture(
    source,
    { hook: 'useEffect', contains: "'selectionchange'" },
    {
      ...bindings,
      refreshCaretArtist: refresh,
    },
  );
  const cleanup = effect();
  try {
    refresh();
    jest.advanceTimersByTime(150);
    cleanup();
    lookup.resolve(true);
    await drain();
    expect(setCaretArtist).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
