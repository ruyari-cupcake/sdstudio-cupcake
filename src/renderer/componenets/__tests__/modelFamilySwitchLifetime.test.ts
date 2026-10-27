import path from 'path';
import loadComponentFixture from '../testSupport/componentFixture';
import {
  deferred,
  flushMicrotasks,
} from '../../models/testSupport/completionMethodHarness';

function fixture() {
  const effects: Array<() => void | (() => void)> = [];
  const setModelVersion = jest.fn();
  const session = { name: 'origin', family: 'v4_5' };
  const appState = { curSession: session, pushMessage: jest.fn() };
  const backend = { getConfig: jest.fn(), setConfig: jest.fn(async () => {}) };
  const switchSessionSamplingFamily = jest.fn(
    (owner: typeof session, family: string) => {
      owner.family = family;
    },
  );
  let stateIndex = 0;
  // The production hook runs with injected hook primitives, not React's dispatcher.
  const evaluateSwitch = loadComponentFixture<Record<string, unknown>>(
    path.resolve(__dirname, '../ModelFamilySwitch.tsx'),
    'useModelFamilySwitch',
    {
      useState: (initial: unknown) => [
        initial,
        stateIndex++ === 0 ? setModelVersion : jest.fn(),
      ],
      useRef: (initial: unknown) => ({ current: initial }),
      useEffect: (effect: () => void | (() => void)) => effects.push(effect),
      appState,
      backend,
      switchSessionSamplingFamily,
      ModelVersion: { V4_5: 'v4_5' },
      samplingFamilyForModel: (model: string) => model,
      modelVersionForSamplingFamily: (family: string) => family,
      sessionService: {
        configChanged: jest.fn(),
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      },
    },
  ) as unknown as () => { switchFamily: (family: string) => Promise<void> };
  return {
    ...evaluateSwitch(),
    effects,
    setModelVersion,
    session,
    appState,
    backend,
    switchSessionSamplingFamily,
  };
}

test('failed model save restores the initiating session after a project switch', async () => {
  const f = fixture();
  const config = deferred<{ modelVersion: string }>();
  f.backend.getConfig.mockReturnValue(config.promise);
  const pending = f.switchFamily('v5');
  const other = { name: 'other', family: 'v5' };
  f.appState.curSession = other;
  config.reject(new Error('disk unavailable'));
  await pending;
  expect(f.switchSessionSamplingFamily.mock.calls).toEqual([
    [f.session, 'v5'],
    [f.session, 'v4_5'],
  ]);
  expect(other.family).toBe('v5');
});

test('a second activation before React commits cannot start another model save', async () => {
  const f = fixture();
  const config = deferred<{ modelVersion: string }>();
  f.backend.getConfig.mockReturnValue(config.promise);
  const first = f.switchFamily('v5');
  const second = f.switchFamily('v5');
  expect(f.backend.getConfig).toHaveBeenCalledTimes(1);
  config.resolve({ modelVersion: 'v4_5' });
  await Promise.all([first, second]);
  expect(f.backend.setConfig).toHaveBeenCalledTimes(1);
});

test('late initial config cannot undo a completed user model switch', async () => {
  const f = fixture();
  const initial = deferred<{ modelVersion: string }>();
  f.backend.getConfig
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValue({ modelVersion: 'v4_5' });
  const cleanup = f.effects[0]();
  try {
    await f.switchFamily('v5');
    expect(f.setModelVersion).toHaveBeenLastCalledWith('v5');
    initial.resolve({ modelVersion: 'v4_5' });
    await flushMicrotasks();
    expect(f.setModelVersion).toHaveBeenLastCalledWith('v5');
  } finally {
    if (cleanup) cleanup();
  }
});
