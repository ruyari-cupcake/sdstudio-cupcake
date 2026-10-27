import {
  SceneNavigationCoordinator,
  type SceneNavigationRequest,
} from '../sceneNavigation';

const target = {
  sessionName: 'project',
  sceneType: 'inpaint' as const,
  sceneName: 'target',
  filename: 'result.png',
  openGrid: false,
};

describe('scene navigation ownership', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('replays a pending intent to a late matching view without a readiness deadline', async () => {
    const navigation = new SceneNavigationCoordinator();
    const pending = navigation.request(target);
    let completed = false;
    void pending.then(() => {
      completed = true;

      return undefined;
    });
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    const wrongTab = jest.fn();
    const unregisterWrong = navigation.registerTabHost(
      'other-project',
      wrongTab,
    );
    expect(wrongTab).not.toHaveBeenCalled();
    const activate = jest.fn();
    const unregisterTab = navigation.registerTabHost('project', activate);
    expect(activate).toHaveBeenCalledWith('inpaint');
    let request!: SceneNavigationRequest;
    const unregisterScene = navigation.registerSceneHost(
      'project',
      'inpaint',
      (value) => {
        request = value;
      },
    );
    expect(request.target).toEqual(target);
    expect(request.isCurrent()).toBe(true);
    request.complete();
    await expect(pending).resolves.toBe(true);
    unregisterScene();
    unregisterTab();
    unregisterWrong();
  });

  it('removes abort ownership and never replays a canceled request to a later view', async () => {
    const navigation = new SceneNavigationCoordinator();
    const controller = new AbortController();
    const removed = jest.spyOn(controller.signal, 'removeEventListener');
    const pending = navigation.request(target, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe(false);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    const activate = jest.fn();
    const accept = jest.fn();
    const unregisterTab = navigation.registerTabHost('project', activate);
    const unregisterScene = navigation.registerSceneHost(
      'project',
      'inpaint',
      accept,
    );
    expect(activate).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
    unregisterScene();
    unregisterTab();
  });

  it('a superseded request cannot complete the new owner, and actual tab unmount cancels it', async () => {
    const navigation = new SceneNavigationCoordinator();
    const seen: SceneNavigationRequest[] = [];
    const unregisterTab = navigation.registerTabHost('project', jest.fn());
    const unregisterScene = navigation.registerSceneHost(
      'project',
      'inpaint',
      (value) => seen.push(value),
    );
    const first = navigation.request(target);
    const second = navigation.request({ ...target, sceneName: 'new-target' });
    await expect(first).resolves.toBe(false);
    seen[0].complete();
    expect(seen[1].isCurrent()).toBe(true);
    unregisterTab();
    await expect(second).resolves.toBe(false);
    seen[1].complete();
    expect(seen[1].isCurrent()).toBe(false);
    unregisterScene();
  });
});
