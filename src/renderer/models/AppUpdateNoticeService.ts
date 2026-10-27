import type { Backend } from '../backend';
import { APP_RELEASE_CHANNEL } from '../../shared/appIdentity';
import {
  compareReleaseVersions,
  type UpdateBackend,
  type UpdateProgress,
  type UpdateRelease,
  type UpdateState,
} from '../../shared/appUpdate';

export type AppUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Renderer presentation for the native updater. Native code owns repository
 * identity, credentials, persisted snooze and downloaded bytes; this service
 * owns one view of their state and never starts a periodic polling loop. */
export class AppUpdateNoticeService extends EventTarget {
  current = '';

  latestVersion = '';

  outdated = false;

  notifiedVersion = '';

  state: UpdateState | null = null;

  release: UpdateRelease | null = null;

  progress: UpdateProgress | null = null;

  phase: AppUpdatePhase = 'idle';

  error = '';

  checked = false;

  notificationOpen = false;

  connecting = false;

  settingsDirty = false;

  cancelling = false;

  private initialization?: Promise<void>;

  private startup?: Promise<void>;

  private checking?: Promise<{ outdated: boolean; latest: string }>;

  private downloading?: Promise<void>;

  private revision = 0;

  private downloadRevision = 0;

  constructor(
    private readonly backend: Pick<Backend, 'getVersion' | 'updates'>,
  ) {
    super();
  }

  private changed(): void {
    this.dispatchEvent(new Event('changed'));
  }

  setSettingsDirty(dirty: boolean): void {
    if (this.settingsDirty === dirty) return;
    this.settingsDirty = dirty;
    this.changed();
  }

  reportError(error: unknown): void {
    this.error = errorMessage(error);
    this.changed();
  }

  private api(): UpdateBackend {
    if (!this.backend.updates)
      throw new Error('이 환경에서는 자동 업데이트를 사용할 수 없어요.');
    return this.backend.updates;
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeState().catch((error) => {
        // A real read failure may be retried from settings. Startup still remains
        // a single attempt, and an unavailable state is never called "latest".
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async initializeState(): Promise<void> {
    const api = this.backend.updates;
    this.state = api
      ? await api.getState()
      : {
          channel: APP_RELEASE_CHANNEL.private ? 'private' : 'public',
          connected: false,
          supported: false,
          version: await this.backend.getVersion(),
          snoozedUntil: 0,
        };
    this.current = this.state.version;
    if (api) {
      // The service is an application singleton. Subscribe only after its first
      // successful initialization, so a failed read cannot duplicate listeners.
      api.onProgress((progress) => {
        if (
          this.phase !== 'downloading' ||
          this.cancelling ||
          progress.version !== this.release?.version
        )
          return;
        this.progress = progress;
        this.changed();
      });
      api.onInstallError((message) => this.failInstall(message));
    }
    this.changed();
  }

  run(): Promise<void> {
    if (!this.startup) {
      this.startup = this.checkAtStartup().catch((error) => {
        this.error = errorMessage(error);
        this.changed();
      });
    }
    return this.startup;
  }

  private async checkAtStartup(): Promise<void> {
    await this.initialize();
    if (!this.backend.updates) return;
    if (!(await this.api().claimStartupCheck())) return;
    if (
      !this.state?.supported ||
      (this.state.channel === 'private' && !this.state.connected)
    )
      return;
    if (this.state.snoozedUntil > Date.now()) return;
    await this.checkForUpdate(false);
  }

  checkForUpdate(
    manual = true,
  ): Promise<{ outdated: boolean; latest: string }> {
    if (!this.checking) {
      this.checking = this.check(manual).finally(() => {
        this.checking = undefined;
      });
    }
    return this.checking;
  }

  private async check(
    manual: boolean,
  ): Promise<{ outdated: boolean; latest: string }> {
    await this.initialize();
    const api = this.api();
    if (!this.state?.supported)
      throw new Error('이 환경에서는 자동 업데이트를 사용할 수 없어요.');
    if (this.state.channel === 'private' && !this.state.connected)
      throw new Error('비공개 업데이트를 먼저 연결해 주세요.');
    if (['downloading', 'ready', 'installing'].includes(this.phase)) {
      if (manual && this.phase !== 'installing') this.show();
      return { outdated: this.outdated, latest: this.latestVersion };
    }

    const { revision } = this;
    this.phase = 'checking';
    this.checked = false;
    this.error = '';
    this.changed();
    try {
      const release = await api.check();
      if (revision !== this.revision) return { outdated: false, latest: '' };
      if (release && release.channel !== this.state.channel)
        throw new Error('이 앱의 업데이트 파일이 아니에요.');
      this.release =
        release && this.isOutdated(release.version) ? release : null;
      this.latestVersion = this.release?.version ?? '';
      this.outdated = this.release !== null;
      this.checked = true;
      this.phase = this.release ? 'available' : 'idle';
      if (this.release && (manual || this.state.snoozedUntil <= Date.now())) {
        this.notificationOpen = true;
        this.notifiedVersion = this.release.version;
        this.dispatchEvent(new CustomEvent('updated'));
      }
      this.changed();
      return { outdated: this.outdated, latest: this.latestVersion };
    } catch (error) {
      if (revision === this.revision) {
        this.error = errorMessage(error);
        this.phase = this.release ? 'available' : 'idle';
        this.changed();
      }
      throw error;
    }
  }

  dismiss(): void {
    this.notificationOpen = false;
    this.changed();
  }

  show(): void {
    if (!this.release) return;
    this.notificationOpen = true;
    this.changed();
  }

  async snooze(): Promise<void> {
    try {
      await this.api().snooze();
      this.state = await this.api().getState();
      this.notificationOpen = false;
      this.error = '';
      this.changed();
    } catch (error) {
      this.error = errorMessage(error);
      this.changed();
      throw error;
    }
  }

  async connect(token: string): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.error = '';
    this.changed();
    try {
      await this.api().connect(token);
      this.revision += 1;
      this.state = await this.api().getState();
      this.checked = false;
    } catch (error) {
      this.error = errorMessage(error);
      throw error;
    } finally {
      this.connecting = false;
      this.changed();
    }
  }

  async disconnect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    this.revision += 1;
    this.changed();
    try {
      await this.api().disconnect();
      this.state = await this.api().getState();
      this.release = null;
      this.latestVersion = '';
      this.outdated = false;
      this.checked = false;
      this.notificationOpen = false;
      this.progress = null;
      this.phase = 'idle';
      this.error = '';
    } catch (error) {
      this.error = errorMessage(error);
      throw error;
    } finally {
      this.connecting = false;
      this.changed();
    }
  }

  download(): Promise<void> {
    if (!this.downloading) {
      this.downloading = this.downloadRelease().finally(() => {
        this.downloading = undefined;
      });
    }
    return this.downloading;
  }

  private async downloadRelease(): Promise<void> {
    if (!this.release) throw new Error('먼저 업데이트를 확인해 주세요.');
    if (this.phase === 'ready' || this.phase === 'installing') return;
    const revision = ++this.downloadRevision;
    this.phase = 'downloading';
    this.progress = null;
    this.error = '';
    this.notificationOpen = true;
    this.changed();
    try {
      await this.api().download(this.release.version);
      if (revision !== this.downloadRevision || this.cancelling) return;
      this.phase = 'ready';
      this.changed();
    } catch (error) {
      if (revision !== this.downloadRevision || this.cancelling) return;
      this.phase = 'available';
      this.error = errorMessage(error);
      this.changed();
      throw error;
    }
  }

  async cancelDownload(): Promise<void> {
    if (this.cancelling) return;
    this.cancelling = true;
    this.changed();
    try {
      // Native cancellation acknowledges after the original download settles;
      // preserve its ownership until then and ignore its late progress/error.
      await this.api().cancelDownload();
      this.downloadRevision += 1;
      this.phase = this.release ? 'available' : 'idle';
      this.progress = null;
      this.error = '';
    } catch (error) {
      this.phase = this.release ? 'available' : 'idle';
      this.error = errorMessage(error);
      throw error;
    } finally {
      this.cancelling = false;
      this.changed();
    }
  }

  beginInstall(): void {
    if (this.phase !== 'ready')
      throw new Error('업데이트 파일을 먼저 받아 주세요.');
    this.phase = 'installing';
    this.error = '';
    this.changed();
  }

  finishAndroidInstall(): void {
    if (this.phase !== 'installing') return;
    this.phase = 'ready';
    this.notificationOpen = false;
    this.changed();
  }

  failInstall(error: unknown): void {
    if (this.phase === 'installing') this.phase = 'ready';
    this.error = errorMessage(error);
    this.notificationOpen = true;
    this.changed();
  }

  isOutdated(latest: string): boolean {
    return compareReleaseVersions(this.current, latest) < 0;
  }
}
