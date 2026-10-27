import path from 'path';
import loadFunctionFixture from '../testSupport/functionFixture';

const source = (name: string) => path.resolve(__dirname, `../${name}.tsx`);
const drain = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function favoriteFixture() {
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const windowTarget = new EventTarget();
  const appState = { curSession: { name: 'origin' }, pushMessage: jest.fn() };
  const sessionService = {
    toggleFavorite: jest.fn(() => pending),
    isFavorite: jest.fn(() => true),
  };
  const effect = loadFunctionFixture(
    source('App'),
    { hook: 'useEffect', contains: 'toggle-project-favorite' },
    {
      appState,
      sessionService,
      window: windowTarget,
      isMobile: false,
    },
  );
  const cleanup = effect();
  windowTarget.dispatchEvent(
    new CustomEvent('shortcut-action', {
      detail: { action: 'toggle-project-favorite' },
    }),
  );
  return { appState, sessionService, complete, cleanup };
}

test('favorite completion reads the project that began the operation', async () => {
  const f = favoriteFixture();
  f.appState.curSession = { name: 'replacement' };
  f.complete();
  await drain();
  expect(f.sessionService.isFavorite).toHaveBeenCalledWith('origin');
  expect(f.sessionService.toggleFavorite).toHaveBeenCalledWith('origin');
  f.cleanup();
});

test('favorite persistence may finish after teardown without publishing a dead UI message', async () => {
  const f = favoriteFixture();
  f.cleanup();
  f.complete();
  await drain();
  expect(f.sessionService.toggleFavorite).toHaveBeenCalledTimes(1);
  expect(f.appState.pushMessage).not.toHaveBeenCalled();
});

test('closing preset management reopens its export chooser in the same committed action', () => {
  const session = {};
  const appState = {
    lastExportType: 'scene',
    lastExportSession: session,
    lastExportSelected: ['selected'],
    curSession: session,
    closeExportPresetManager: jest.fn(),
    exportPackage: jest.fn(),
  };
  const timers = jest.fn();
  const close = loadFunctionFixture(
    source('ExportPresetManager'),
    { name: 'onClose' },
    { appState, setTimeout: timers },
  );
  close();
  expect(appState.closeExportPresetManager).toHaveBeenCalledTimes(1);
  expect(appState.exportPackage).toHaveBeenCalledWith('scene', ['selected']);
  expect(timers).not.toHaveBeenCalled();
});

test('closing preset management never reopens export for a different project', () => {
  const appState = {
    lastExportType: 'scene',
    lastExportSession: {},
    lastExportSelected: [],
    curSession: {},
    closeExportPresetManager: jest.fn(),
    exportPackage: jest.fn(),
  };
  const timers: (() => void)[] = [];
  const close = loadFunctionFixture(
    source('ExportPresetManager'),
    { name: 'onClose' },
    {
      appState,
      setTimeout: (callback: () => void) => {
        timers.push(callback);
      },
    },
  );
  close();
  timers.forEach((callback) => callback());
  expect(appState.exportPackage).not.toHaveBeenCalled();
});

test('image review focuses its committed dialog without a zero-delay timer', () => {
  const focus = jest.fn();
  const timers = { setTimeout: jest.fn(), clearTimeout: jest.fn() };
  const effect = loadFunctionFixture(
    source('ImageReview'),
    { hook: 'useLayoutEffect', contains: 'rootRef.current?.focus' },
    {
      rootRef: { current: { focus } },
      window: timers,
    },
  );
  effect();
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(timers.setTimeout).not.toHaveBeenCalled();
});

function confirmFocusFixture(inputValue: string) {
  const topDialog = { type: 'input-confirm', inputValue: 'prefilled' };
  const input = { value: inputValue, focus: jest.fn(), select: jest.fn() };
  const pendingFocusRef = { current: topDialog };
  const effect = loadFunctionFixture(
    source('ConfirmWindow'),
    { hook: 'effect', contains: 'inputRef.current' },
    {
      topDialog,
      inputValue,
      inputRef: { current: input },
      textareaRef: { current: null },
      pendingFocusRef,
      setInputValue: jest.fn(),
      setCheckedItems: jest.fn(),
      setSkipConfirm: jest.fn(),
      setDropdownMenuOpen: jest.fn(),
      setInputError: jest.fn(),
      validatingRef: { current: null },
      setValidating: jest.fn(),
      window: { setTimeout: jest.fn(), clearTimeout: jest.fn() },
    },
  );
  return { input, pendingFocusRef, effect };
}

test('confirmation focuses and selects the prefilled value after its state has committed', () => {
  const f = confirmFocusFixture('prefilled');
  f.effect();
  expect(f.input.focus).toHaveBeenCalledTimes(1);
  expect(f.input.select).toHaveBeenCalledTimes(1);
});

test('confirmation waits for the new dialog value to commit before selecting it', () => {
  const f = confirmFocusFixture('previous dialog text');
  f.effect();
  expect(f.input.focus).not.toHaveBeenCalled();
  expect(f.input.select).not.toHaveBeenCalled();
  expect(f.pendingFocusRef.current).toEqual({
    type: 'input-confirm',
    inputValue: 'prefilled',
  });
});
