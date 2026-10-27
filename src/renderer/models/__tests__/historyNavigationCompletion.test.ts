/** @jest-environment jsdom */
import path from 'path';
import {
  deferred,
  flushMicrotasks,
  loadServiceMethods,
} from '../testSupport/completionMethodHarness';

const source = path.resolve(__dirname, '../ImageHistoryService.ts');

function harness() {
  const ready = deferred<boolean>();
  const appState: any = { curSession: undefined, pushMessage: jest.fn() };
  const sceneNavigation = { request: jest.fn(() => ready.promise) };
  const Subject = loadServiceMethods(
    source,
    'ImageHistoryService',
    ['navigateTo', 'waitForSceneCell'],
    {
      sceneNavigation,
      getAppState: () => appState,
      sessionService: new EventTarget(),
      reaction: jest.fn(() => jest.fn()),
      window,
      document,
      CustomEvent,
      AbortController,
      setTimeout,
      clearTimeout,
    },
  );
  const history = Object.assign(new Subject(), { resolve: jest.fn() });
  return { history, ready, appState, sceneNavigation };
}

const entry = {
  sessionName: 'project',
  sceneType: 'scene',
  sceneName: 'slow-scene',
  filename: 'image.png',
};

describe('history navigation follows view readiness rather than elapsed time', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.replaceChildren();
  });

  it('remains pending beyond the old deadline until the actual view accepts the request', async () => {
    const { history, ready, appState, sceneNavigation } = harness();
    const session = {
      name: 'project',
      scenes: new Map([['slow-scene', {}]]),
      inpaints: new Map(),
    };
    appState.curSession = session;
    history.resolve.mockResolvedValue({ session, scene: {} });
    const result = history.navigateTo(entry, { openGrid: false });
    let settled = false;
    void result.then(() => {
      settled = true;

      return undefined;
    });
    await flushMicrotasks();
    jest.advanceTimersByTime(30_000);
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(sceneNavigation.request).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: 'project',
        sceneType: 'scene',
        sceneName: 'slow-scene',
        openGrid: false,
      }),
      expect.any(AbortSignal),
    );
    ready.resolve(true);
    await result;
  });

  it('a later click cancels an earlier unresolved lookup before it can switch the project', async () => {
    const { history, ready, appState } = harness();
    const oldLookup = deferred<any>();
    const newSession = {
      name: 'new-project',
      scenes: new Map([['new-scene', {}]]),
      inpaints: new Map(),
    };
    history.resolve
      .mockReturnValueOnce(oldLookup.promise)
      .mockResolvedValueOnce({ session: newSession, scene: {} });
    const older = history.navigateTo(entry, { openGrid: false });
    const newer = history.navigateTo(
      { ...entry, sessionName: 'new-project', sceneName: 'new-scene' },
      { openGrid: true },
    );
    await flushMicrotasks();
    oldLookup.resolve({ session: { name: 'old-project' }, scene: {} });
    await flushMicrotasks();
    expect(appState.curSession).toBe(newSession);
    ready.resolve(true);
    await Promise.all([older, newer]);
  });
});
