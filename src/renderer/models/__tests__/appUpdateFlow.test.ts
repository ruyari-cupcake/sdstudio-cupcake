import { AppUpdateNoticeService } from '../AppUpdateNoticeService';
import type {
  UpdateBackend,
  UpdateProgress,
  UpdateRelease,
  UpdateState,
} from '../../../shared/appUpdate';

// Describe the public flow contract before replacing the legacy notice service.
// This keeps the baseline RED on missing behavior, rather than a type error.
interface UpdateFlowContract {
  state: UpdateState | null;
  release: UpdateRelease | null;
  progress: UpdateProgress | null;
  notificationOpen: boolean;
  checked: boolean;
  error: string;
  phase: string;
  snooze(): Promise<void>;
  download(): Promise<void>;
  cancelDownload(): Promise<void>;
  disconnect(): Promise<void>;
  beginInstall(): void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

const release: UpdateRelease = {
  version: '6.1.0-cupcake.2',
  channel: 'private',
  releaseUrl:
    'https://github.com/example/private/releases/tag/v6.1.0-cupcake.2',
  publishedAt: '2026-10-27T00:00:00Z',
  notes: '개선 사항',
  asset: {
    name: 'update.exe',
    sha256: 'a'.repeat(64),
    size: 1234,
    kind: 'windows-portable',
  },
};

function fixture(overrides: Partial<UpdateState> = {}) {
  let state: UpdateState = {
    channel: 'private',
    connected: true,
    supported: true,
    version: '6.1.0-cupcake.1',
    snoozedUntil: 0,
    ...overrides,
  };
  let progress: (value: UpdateProgress) => void = () => {};
  let installError: (message: string) => void = () => {};
  const api: jest.Mocked<UpdateBackend> = {
    getState: jest.fn(async () => ({ ...state })),
    claimStartupCheck: jest.fn(async () => true),
    check: jest.fn(async () => release),
    snooze: jest.fn(async () => {
      state = { ...state, snoozedUntil: Date.now() + 7 * 86400000 };
    }),
    connect: jest.fn(async (_token: string) => {
      state = { ...state, connected: true };
    }),
    disconnect: jest.fn(async () => {
      state = { ...state, connected: false };
    }),
    download: jest.fn(async (_version: string) => {}),
    cancelDownload: jest.fn(async () => {}),
    install: jest.fn(async () => {}),
    cancelInstall: jest.fn(async () => {}),
    onProgress: jest.fn((listener) => {
      progress = listener;
      return () => {};
    }),
    onInstallError: jest.fn((listener) => {
      installError = listener;
      return () => {};
    }),
  };
  const backend = {
    getVersion: jest.fn(async () => state.version),
    updates: api,
  };
  const service = new AppUpdateNoticeService(
    backend,
  ) as AppUpdateNoticeService & UpdateFlowContract;
  return {
    api,
    service,
    progress: (value: UpdateProgress) => progress(value),
    installError: (message: string) => installError(message),
  };
}

describe('application update flow', () => {
  it('checks once at startup and retains the notice for a late mounted view', async () => {
    const { service, api } = fixture();
    await Promise.all([service.run(), service.run()]);
    await service.run();
    expect(api.claimStartupCheck).toHaveBeenCalledTimes(1);
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(service.notificationOpen).toBe(true);
    expect(service.release?.version).toBe('6.1.0-cupcake.2');
  });

  it('keeps a persisted week of silence across startup but lets manual checks through', async () => {
    const { service, api } = fixture({ snoozedUntil: Date.now() + 86400000 });
    await service.run();
    expect(api.check).not.toHaveBeenCalled();
    await service.checkForUpdate();
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(service.notificationOpen).toBe(true);
  });

  it('does not claim an unconnected private build is up to date', async () => {
    const { service, api } = fixture({ connected: false });
    await service.run();
    expect(api.check).not.toHaveBeenCalled();
    expect(service.checked).toBe(false);
    await expect(service.checkForUpdate()).rejects.toThrow('연결');
    expect(service.checked).toBe(false);
  });

  it('claims startup while disconnected so another window cannot repeat it after connection', async () => {
    const { service, api } = fixture({ connected: false });
    let startupClaimed = false;
    api.claimStartupCheck.mockImplementation(async () => {
      if (startupClaimed) return false;
      startupClaimed = true;
      return true;
    });
    await service.run();
    expect(api.claimStartupCheck).toHaveBeenCalledTimes(1);
    expect(api.check).not.toHaveBeenCalled();

    await service.connect('test-token');
    await service.checkForUpdate();
    service.dismiss();
    const secondWindow = new AppUpdateNoticeService({
      getVersion: async () => '6.1.0-cupcake.1',
      updates: api,
    });
    await secondWindow.run();
    expect(api.check).toHaveBeenCalledTimes(1);
    expect(secondWindow.notificationOpen).toBe(false);
  });

  it.each(['downloading', 'ready'] as const)(
    'reopens an existing %s update for a manual check without another lookup',
    async (phase) => {
      const { service, api } = fixture({ snoozedUntil: Date.now() + 86400000 });
      await service.checkForUpdate();
      const pending = deferred<void>();
      api.download.mockReturnValueOnce(pending.promise);
      const downloading = service.download();
      if (phase === 'ready') {
        pending.resolve();
        await downloading;
      }
      expect(service.phase).toBe(phase);
      service.dismiss();
      await service.checkForUpdate();
      expect(service.notificationOpen).toBe(true);
      expect(api.check).toHaveBeenCalledTimes(1);
      expect(api.download).toHaveBeenCalledTimes(1);
      pending.resolve();
      await downloading;
    },
  );

  it('shows a failed manual lookup as a failure without falsely reporting latest', async () => {
    const { service, api } = fixture();
    api.check.mockRejectedValueOnce(new Error('연결 실패'));
    await expect(service.checkForUpdate()).rejects.toThrow('연결 실패');
    expect(service.error).toBe('연결 실패');
    expect(service.checked).toBe(false);
    expect(service.phase).toBe('idle');
  });

  it('compares the complete SemVer including prerelease numbers', () => {
    const { service } = fixture();
    service.current = '6.1.0-cupcake.2';
    expect(service.isOutdated('6.1.0-cupcake.10')).toBe(true);
    service.current = '6.1.0-cupcake.10';
    expect(service.isOutdated('6.1.0-cupcake.2')).toBe(false);
    service.current = '6.1.0';
    expect(service.isOutdated('6.1.0-cupcake.10')).toBe(false);
  });

  it('publishes a snooze only after the durable native write succeeds', async () => {
    const { service, api } = fixture();
    await service.run();
    api.snooze.mockRejectedValueOnce(new Error('저장 실패'));
    await expect(service.snooze()).rejects.toThrow('저장 실패');
    expect(service.notificationOpen).toBe(true);
    expect(service.state?.snoozedUntil).toBe(0);
    await service.snooze();
    expect(service.notificationOpen).toBe(false);
    expect(service.state!.snoozedUntil).toBeGreaterThan(Date.now());
  });

  it('owns one download and ignores late completion after cancellation', async () => {
    const { service, api, progress } = fixture();
    await service.run();
    const pending = deferred<void>();
    api.download.mockReturnValueOnce(pending.promise);
    const first = service.download();
    const second = service.download();
    await Promise.resolve();
    expect(api.download).toHaveBeenCalledTimes(1);
    progress({
      phase: 'downloading',
      received: 50,
      total: 100,
      version: release.version,
    });
    expect(service.progress?.received).toBe(50);
    await service.cancelDownload();
    pending.resolve();
    await Promise.all([first, second]);
    expect(service.phase).toBe('available');
    progress({
      phase: 'ready',
      received: 100,
      total: 100,
      version: release.version,
    });
    expect(service.phase).toBe('available');
  });

  it('discards an account lookup that finishes after disconnect', async () => {
    const { service, api } = fixture();
    const pending = deferred<UpdateRelease | null>();
    const started = deferred<void>();
    api.check.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const checking = service.checkForUpdate();
    await started.promise;
    await service.disconnect();
    pending.resolve(release);
    await checking;
    expect(service.release).toBeNull();
    expect(service.notificationOpen).toBe(false);
    expect(service.state?.connected).toBe(false);
  });

  it('reopens interaction and exposes an error when native installation fails', async () => {
    const { service, installError } = fixture();
    await service.run();
    await service.download();
    service.beginInstall();
    expect(service.phase).toBe('installing');
    installError('작업을 저장하지 못했어요.');
    expect(service.phase).toBe('ready');
    expect(service.error).toBe('작업을 저장하지 못했어요.');
  });
});
