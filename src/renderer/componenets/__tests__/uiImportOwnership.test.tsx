import path from 'path';
import React, {
  act,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import loadFunctionFixture from '../testSupport/functionFixture';
import loadComponentFixture from '../testSupport/componentFixture';

const source = (name: string) => path.resolve(__dirname, `../${name}.tsx`);
const drain = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};
beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function importFixture() {
  const makeSession = () => ({
    extraPrompt: 'existing project prompt',
    selectedWorkflow: { workflowType: 'SDImageGen', presetName: 'first' },
    presets: new Map([
      [
        'SDImageGen',
        [
          { name: 'first', frontPrompt: 'first original' },
          { name: 'second', frontPrompt: 'second original' },
        ],
      ],
    ]),
    presetShareds: new Map(),
  });
  const origin = makeSession();
  const replacement = makeSession();
  let confirm!: (value: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    confirm = resolve;
  });
  const appState = {
    curSession: origin,
    confirmAsync: jest.fn(() => pending),
    pushMessage: jest.fn(),
  };
  const options = {
    prompt: true,
    uc: false,
    characters: false,
    settings: false,
    modelSettings: false,
    seed: false,
    vibes: false,
    resolution: false,
  };
  const backend = {
    getConfig: jest.fn(async () => ({})),
    setConfig: jest.fn(async () => {}),
  };
  const onClose = jest.fn();
  const applyImport = loadFunctionFixture(
    source('ExternalImageView'),
    { name: 'applyImport' },
    {
      appState,
      options,
      backend,
      onClose,
      target: 'current',
      image: 'png',
      promptPlan: {
        split: true,
        frontPrompt: 'imported',
        extraPrompt: 'imported extra',
      },
      normalScene: undefined,
      scene: undefined,
      job: {
        characterPrompts: [],
        vibes: [],
        characterReferences: [],
        naiModelSettings: { model: 'saved' },
      },
      hasCharacters: false,
      hasVibes: false,
      hasCharRefs: false,
      setImporting: jest.fn(),
      runInAction: (callback: () => void) => callback(),
      sessionService: { configChanged: jest.fn() },
      importingRef: { current: false },
      importAliveRef: { current: true },
      importContextRef: { current: { image: 'png', target: 'current' } },
    },
  );
  return {
    applyImport,
    confirm,
    origin,
    replacement,
    appState,
    options,
    backend,
    onClose,
  };
}

test('an image confirmation cannot overwrite a project selected while the confirmation was open', async () => {
  const f = importFixture();
  const pending = f.applyImport();
  f.appState.curSession = f.replacement;
  f.confirm(true);
  await pending;
  expect(f.replacement.extraPrompt).toBe('existing project prompt');
  expect(f.replacement.presets.get('SDImageGen')?.[0].frontPrompt).toBe(
    'first original',
  );
  expect(f.origin.extraPrompt).toBe('existing project prompt');
  expect(f.onClose).not.toHaveBeenCalled();
});

test('an image confirmation cannot silently retarget another selected preset', async () => {
  const f = importFixture();
  const pending = f.applyImport();
  f.origin.selectedWorkflow = {
    workflowType: 'SDImageGen',
    presetName: 'second',
  };
  f.confirm(true);
  await pending;
  expect(f.origin.presets.get('SDImageGen')?.[1].frontPrompt).toBe(
    'second original',
  );
  expect(f.onClose).not.toHaveBeenCalled();
});

test('repeated image import activation owns only one confirmation and one operation', async () => {
  const f = importFixture();
  const first = f.applyImport();
  const second = f.applyImport();
  expect(f.appState.confirmAsync).toHaveBeenCalledTimes(1);
  f.confirm(false);
  await Promise.all([first, second]);
});

test('an image settings persistence failure is visible and cannot report completion', async () => {
  const f = importFixture();
  f.options.modelSettings = true;
  f.backend.getConfig.mockRejectedValue(new Error('settings read failed'));
  const pending = f.applyImport();
  f.confirm(true);
  await expect(pending).resolves.toBeUndefined();
  expect(f.onClose).not.toHaveBeenCalled();
  expect(f.appState.pushMessage).toHaveBeenCalledWith(
    expect.stringContaining('실패'),
    'error',
  );
});

function defaultsFixture(getItem: (key: string) => string | null) {
  return loadComponentFixture(
    source('CharacterReferenceEditor'),
    'getRefDefaults',
    {
      localStorage: { getItem },
      console: { warn: jest.fn() },
      REF_DEFAULT_STRENGTH_KEY: 'strength',
      REF_DEFAULT_FIDELITY_KEY: 'fidelity',
      REF_DEFAULT_TYPE_KEY: 'type',
    },
  ) as unknown as () => {
    strength: number;
    fidelity: number;
    referenceType: string;
  };
}
test('unavailable local storage cannot blank the reference editor during render', () => {
  const getDefaults = defaultsFixture(() => {
    throw new Error('Storage access denied');
  });
  expect(getDefaults()).toEqual({
    strength: 0.6,
    fidelity: 1,
    referenceType: 'character',
  });
});
test('invalid stored reference defaults cannot put NaN, infinity or an invalid type into controls', () => {
  const getDefaults = defaultsFixture(
    (key) =>
      ({ strength: 'NaN', fidelity: 'Infinity', type: 'unknown' })[key] ?? null,
  );
  expect(getDefaults()).toEqual({
    strength: 0.6,
    fidelity: 1,
    referenceType: 'character',
  });
});
test('finite negative reference defaults remain user-controlled', () => {
  const getDefaults = defaultsFixture(
    (key) =>
      ({ strength: '-0.5', fidelity: '2.25', type: 'character&style' })[key] ??
      null,
  );
  expect(getDefaults()).toEqual({
    strength: -0.5,
    fidelity: 2.25,
    referenceType: 'character&style',
  });
});

test('a pasted reference cannot start persistence after its editor was unmounted', async () => {
  const readers: { onload?: (event: unknown) => unknown; abort: () => void }[] =
    [];
  class Reader {
    static LOADING = 1;

    readyState = 1;

    onload?: (event: unknown) => unknown;

    onerror?: () => void;

    onabort?: () => void;

    error = null;

    abort = jest.fn(() => {
      this.readyState = 2;
      this.onabort?.();
    });

    readAsDataURL = jest.fn();

    constructor() {
      readers.push(this);
    }
  }
  const storeReferenceImage = jest.fn(async () => 'reference.png');
  const context = createContext({
    preset: { references: [] },
    shared: {},
    meta: {},
    editCharacterReference: { fieldType: 'preset', field: 'references' },
    setEditCharacterReference: jest.fn(),
  });
  const Editor = loadComponentFixture<{ disabled: boolean }>(
    source('CharacterReferenceEditor'),
    'CharacterReferenceEditor',
    {
      React,
      useCallback,
      useContext,
      useEffect,
      useRef,
      useState,
      observer: (component: unknown) => component,
      appState: { curSession: { name: 'origin' }, pushMessage: jest.fn() },
      WFElementContext: context,
      getRefDefaults: () => ({
        strength: 0.6,
        fidelity: 1,
        referenceType: 'character',
      }),
      ReferenceItem: { fromJSON: (value: unknown) => value },
      imageService: { storeReferenceImage },
      useNarrowContainer: () => false,
      isMobile: false,
      FileReader: Reader,
      window,
      ActionIcon: () => null,
      Tooltip: ({ children }: { children: React.ReactNode }) => children,
      FileUploadBase64: () => null,
      FaTimes: 'span',
      FaTrash: 'span',
      FaToggleOn: 'span',
      FaToggleOff: 'span',
      EditableSliderValue: () => null,
      VibeImage: () => null,
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let mounted = true;
  try {
    act(() => root.render(<Editor disabled={false} />));
    act(() =>
      window.dispatchEvent(
        Object.assign(new Event('paste', { cancelable: true }), {
          clipboardData: {
            items: [
              { type: 'image/png', getAsFile: () => ({ type: 'image/png' }) },
            ],
          },
        }),
      ),
    );
    expect(readers).toHaveLength(1);
    act(() => root.unmount());
    mounted = false;
    readers[0].onload?.({
      target: { result: 'data:image/png;base64,example' },
    });
    await drain();
    expect(storeReferenceImage).not.toHaveBeenCalled();
  } finally {
    if (mounted) act(() => root.unmount());
    container.remove();
  }
});

function driveFixture() {
  let fail!: (error: Error) => void;
  const pending = new Promise<boolean>((_resolve, reject) => {
    fail = reject;
  });
  const statusRevisionRef = { current: 0 };
  const setConnectionError = jest.fn();
  const effect = loadFunctionFixture(
    source('DriveSettingsTab'),
    { hook: 'useEffect', contains: 'isGoogleDriveConnected()' },
    {
      supported: true,
      statusRevisionRef,
      setConnectionError,
      setConnected: jest.fn(),
      isGoogleDriveConnected: () => ({
        then: (onFulfilled: (value: boolean) => void) => {
          const completion = pending.then(onFulfilled);
          completion.catch(() => undefined);
          return completion;
        },
      }),
    },
  );
  const cleanup = effect();
  return { fail, statusRevisionRef, setConnectionError, cleanup };
}
test('a drive connection read failure reaches a visible terminal state', async () => {
  const f = driveFixture();
  f.fail(new Error('native bridge unavailable'));
  await drain();
  expect(f.setConnectionError).toHaveBeenCalledWith(
    expect.stringContaining('native bridge unavailable'),
  );
  f.cleanup();
});
test('a late initial drive read cannot replace newer status from the connection control', async () => {
  const f = driveFixture();
  f.statusRevisionRef.current += 1;
  f.fail(new Error('obsolete read'));
  await drain();
  expect(f.setConnectionError).not.toHaveBeenCalled();
  f.cleanup();
});
