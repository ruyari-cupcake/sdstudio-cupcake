export interface SceneNavigationTarget {
  sessionName: string;
  sceneType: 'scene' | 'inpaint';
  sceneName: string;
  filename: string;
  openGrid: boolean;
}

export interface SceneNavigationRequest {
  readonly target: SceneNavigationTarget;
  isCurrent(): boolean;
  complete(): void;
  cancel(): void;
}

type TabHost = (type: SceneNavigationTarget['sceneType']) => void;
type SceneHost = (request: SceneNavigationRequest) => void;

/** One navigation intent survives late view mounts and ends at a real view commit or cancellation. */
export class SceneNavigationCoordinator {
  private tabs = new Map<string, TabHost>();

  private scenes = new Map<string, SceneHost>();

  private pending?: {
    request: SceneNavigationRequest;
    resolve: (completed: boolean) => void;
    cleanup: () => void;
  };

  private static key(
    session: string,
    type: SceneNavigationTarget['sceneType'],
  ) {
    return JSON.stringify([session, type]);
  }

  private settle(request: SceneNavigationRequest, completed: boolean) {
    if (this.pending?.request !== request) return;
    const { pending } = this;
    this.pending = undefined;
    pending.cleanup();
    pending.resolve(completed);
  }

  request(
    target: SceneNavigationTarget,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.pending?.request.cancel();
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const request: SceneNavigationRequest = {
        target: { ...target },
        isCurrent: () => this.pending?.request === request,
        complete: () => this.settle(request, true),
        cancel: () => this.settle(request, false),
      };
      const onAbort = () => request.cancel();
      this.pending = {
        request,
        resolve,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.tabs.get(target.sessionName)?.(target.sceneType);
      if (request.isCurrent())
        this.scenes.get(
          SceneNavigationCoordinator.key(target.sessionName, target.sceneType),
        )?.(request);
    });
  }

  cancelForSession(sessionName: string) {
    if (this.pending?.request.target.sessionName === sessionName)
      this.pending.request.cancel();
  }

  registerTabHost(sessionName: string, activate: TabHost): () => void {
    this.tabs.set(sessionName, activate);
    if (this.pending?.request.target.sessionName === sessionName)
      activate(this.pending.request.target.sceneType);
    return () => {
      if (this.tabs.get(sessionName) !== activate) return;
      this.tabs.delete(sessionName);
      this.cancelForSession(sessionName);
    };
  }

  registerSceneHost(
    sessionName: string,
    type: SceneNavigationTarget['sceneType'],
    accept: SceneHost,
  ): () => void {
    const key = SceneNavigationCoordinator.key(sessionName, type);
    this.scenes.set(key, accept);
    const request = this.pending?.request;
    if (
      request &&
      request.target.sessionName === sessionName &&
      request.target.sceneType === type
    )
      accept(request);
    return () => {
      if (this.scenes.get(key) === accept) this.scenes.delete(key);
    };
  }
}

export const sceneNavigation = new SceneNavigationCoordinator();
