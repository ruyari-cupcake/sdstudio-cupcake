import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { promises as fs, createReadStream } from 'fs';
import { Readable } from 'stream';
import {
  UPDATE_SNOOZE_MS,
  type UpdateProgress,
  type UpdateRelease,
  type UpdateState,
} from '../shared/appUpdate';
import {
  GithubReleaseClient,
  type CheckedUpdate,
  type GithubUpdateIdentity,
} from './githubRelease';

interface StoredPreferences {
  schema: 1;
  repository: string;
  channel: string;
  snoozedUntil: number;
  encryptedToken?: string;
}
export interface DownloadedUpdate {
  release: UpdateRelease;
  artifactPath: string;
  dataRoot: string;
}
export interface DesktopUpdaterOptions {
  identity: GithubUpdateIdentity;
  profileRoot: string;
  getDataRoot(): string;
  supported: boolean;
  encryptToken(token: string): string;
  decryptToken(cipher: string): string;
  onProgress(progress: UpdateProgress): void;
  request?: typeof fetch;
  now?: () => number;
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Owns the fixed channel, credential, startup claim and one streaming download. */
export class DesktopReleaseUpdater {
  private readonly client: GithubReleaseClient;

  private preferences?: Promise<StoredPreferences>;

  private writes: Promise<void> = Promise.resolve();

  private claimedStartup = false;

  private checked?: CheckedUpdate;

  private checking?: Promise<UpdateRelease | null>;

  private downloading?: Promise<void>;

  private controller?: AbortController;

  private downloaded?: DownloadedUpdate;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.client = new GithubReleaseClient(options.identity, options.request);
  }

  private get stateFile(): string {
    return path.join(
      this.options.profileRoot,
      `app-update-${this.options.identity.channel}.json`,
    );
  }

  private emptyPreferences(): StoredPreferences {
    return {
      schema: 1,
      repository: `${this.options.identity.owner}/${this.options.identity.repo}`,
      channel: this.options.identity.channel,
      snoozedUntil: 0,
    };
  }

  private load(): Promise<StoredPreferences> {
    if (!this.preferences) {
      this.preferences = (async () => {
        let text: string;
        try {
          text = await fs.readFile(this.stateFile, 'utf8');
        } catch (error: any) {
          if (error.code === 'ENOENT') return this.emptyPreferences();
          throw new Error('업데이트 설정을 읽을 수 없습니다.');
        }
        try {
          const saved = JSON.parse(text) as StoredPreferences;
          const expected = this.emptyPreferences();
          if (
            saved.schema !== 1 ||
            saved.repository !== expected.repository ||
            saved.channel !== expected.channel ||
            !Number.isSafeInteger(saved.snoozedUntil) ||
            saved.snoozedUntil < 0 ||
            (saved.encryptedToken !== undefined &&
              typeof saved.encryptedToken !== 'string')
          )
            throw new Error('format');
          return saved;
        } catch {
          throw new Error(
            '업데이트 설정을 읽을 수 없습니다. 업데이트 연결을 다시 설정해 주세요.',
          );
        }
      })();
    }
    return this.preferences;
  }

  private async commitPreferences(
    change: (value: StoredPreferences) => StoredPreferences,
  ): Promise<void> {
    const previous = await this.load();
    const next = change(previous);
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    await fs.mkdir(this.options.profileRoot, { recursive: true });
    try {
      await fs.writeFile(temporary, JSON.stringify(next), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(temporary, this.stateFile);
      this.preferences = Promise.resolve(next);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private write(
    change: (value: StoredPreferences) => StoredPreferences,
  ): Promise<void> {
    const operation = this.writes.then(() => this.commitPreferences(change));
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  private async token(): Promise<string | undefined> {
    if (this.options.identity.channel === 'public') return undefined;
    const saved = await this.load();
    if (!saved.encryptedToken) return undefined;
    try {
      return this.options.decryptToken(saved.encryptedToken);
    } catch {
      throw new Error('비공개 업데이트를 다시 연결해 주세요.');
    }
  }

  async getState(): Promise<UpdateState> {
    const saved = await this.load();
    return {
      channel: this.options.identity.channel,
      version: this.options.identity.version,
      supported: this.options.supported,
      connected:
        this.options.identity.channel === 'public' ||
        Boolean(saved.encryptedToken),
      snoozedUntil: saved.snoozedUntil,
    };
  }

  async claimStartupCheck(): Promise<boolean> {
    if (this.claimedStartup) return false;
    this.claimedStartup = true;
    return true;
  }

  async connect(token: string): Promise<void> {
    if (this.options.identity.channel !== 'private')
      throw new Error('공개판은 연결 없이 업데이트할 수 있습니다.');
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token))
      throw new Error('GitHub 토큰을 넣어 주세요.');
    if (this.downloading)
      throw new Error('다운로드가 끝난 뒤 연결을 바꿔 주세요.');
    const value = token.trim();
    await this.client.verifyAccess(value);
    const encryptedToken = this.options.encryptToken(value);
    // A deliberate reconnection may replace an unreadable updater-only preference file.
    await this.load().catch(() => {
      this.preferences = Promise.resolve(this.emptyPreferences());
    });
    await this.write((saved) => ({ ...saved, encryptedToken }));
    this.checked = undefined;
  }

  async disconnect(): Promise<void> {
    if (this.downloading)
      throw new Error('다운로드를 취소한 뒤 연결을 해제해 주세요.');
    await this.write(({ encryptedToken: _token, ...saved }) => saved);
    this.checked = undefined;
  }

  async snooze(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    await this.write((saved) => ({
      ...saved,
      snoozedUntil: now + UPDATE_SNOOZE_MS,
    }));
  }

  check(): Promise<UpdateRelease | null> {
    if (this.checking) return this.checking;
    if (this.downloading) return Promise.resolve(this.checked?.release ?? null);
    const operation = (async () => {
      const checked = await this.client.check(await this.token());
      this.checked = checked ?? undefined;
      return checked?.release ?? null;
    })();
    this.checking = operation;
    void operation
      .finally(() => {
        if (this.checking === operation) this.checking = undefined;
      })
      .catch(() => undefined);
    return operation;
  }

  get isDownloading(): boolean {
    return Boolean(this.downloading);
  }

  download(version: string): Promise<void> {
    if (this.downloading) {
      if (this.checked?.release.version === version) return this.downloading;
      return Promise.reject(new Error('다른 업데이트를 받고 있습니다.'));
    }
    const { checked } = this;
    if (!checked || version !== checked.release.version)
      return Promise.reject(new Error('업데이트를 다시 확인해 주세요.'));
    if (!this.options.supported)
      return Promise.reject(
        new Error('설치한 Windows 또는 Android 앱에서 업데이트해 주세요.'),
      );
    this.downloaded = undefined;
    const controller = new AbortController();
    this.controller = controller;
    const operation = this.downloadChecked(checked, controller.signal);
    this.downloading = operation;
    void operation
      .finally(() => {
        if (this.downloading === operation) {
          this.downloading = undefined;
          this.controller = undefined;
        }
      })
      .catch(() => undefined);
    return operation;
  }

  private async downloadChecked(
    checked: CheckedUpdate,
    signal: AbortSignal,
  ): Promise<void> {
    const { release, asset } = checked;
    const dataRoot = this.options.getDataRoot();
    const directory = path.join(
      dataRoot,
      '.updates',
      this.options.identity.channel,
      'download',
    );
    const artifactPath = path.join(directory, release.asset.name);
    const emit = (phase: UpdateProgress['phase'], received: number) =>
      this.options.onProgress({
        phase,
        received,
        total: release.asset.size,
        version: release.version,
      });
    try {
      const stat = await fs.stat(artifactPath).catch(() => null);
      if (
        stat?.isFile() &&
        stat.size === release.asset.size &&
        (await hashFile(artifactPath)) === release.asset.sha256
      ) {
        if (signal.aborted) throw new Error('다운로드를 취소했습니다.');
        this.downloaded = { release, artifactPath, dataRoot };
        emit('ready', release.asset.size);
        return;
      }
      await fs.rm(directory, { recursive: true, force: true });
      await fs.mkdir(directory, { recursive: true });
      const temporary = `${artifactPath}.part`;
      const response = await this.client.openAsset(
        asset,
        await this.token(),
        signal,
      );
      if (!response.body) throw new Error('업데이트 파일을 받지 못했습니다.');
      const announced = response.headers.get('content-length');
      if (announced && Number(announced) !== release.asset.size)
        throw new Error('업데이트 파일 크기가 일치하지 않습니다.');
      const file = await fs.open(temporary, 'wx', 0o600);
      const hash = createHash('sha256');
      let received = 0;
      let lastPercent = -1;
      emit('downloading', 0);
      try {
        const stream = Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0],
        );
        for await (const chunk of stream) {
          if (signal.aborted) throw new Error('다운로드를 취소했습니다.');
          received += chunk.length;
          if (received > release.asset.size)
            throw new Error('업데이트 파일 크기가 일치하지 않습니다.');
          hash.update(chunk);
          await file.writeFile(chunk);
          const percent = Math.floor((received * 100) / release.asset.size);
          if (percent !== lastPercent) {
            lastPercent = percent;
            emit('downloading', received);
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if (
        received !== release.asset.size ||
        hash.digest('hex') !== release.asset.sha256
      )
        throw new Error('다운로드가 온전하지 않습니다. 다시 받아 주세요.');
      if (signal.aborted) throw new Error('다운로드를 취소했습니다.');
      if (this.options.getDataRoot() !== dataRoot)
        throw new Error('저장 위치가 바뀌었습니다. 앱을 다시 시작해 주세요.');
      await fs.rename(temporary, artifactPath);
      this.downloaded = { release, artifactPath, dataRoot };
      emit('ready', received);
    } catch (error) {
      this.downloaded = undefined;
      await fs.rm(directory, { recursive: true, force: true });
      if (signal.aborted) throw new Error('다운로드를 취소했습니다.');
      throw error;
    }
  }

  async cancelDownload(): Promise<void> {
    this.controller?.abort();
    await this.downloading?.catch(() => undefined);
  }

  getDownloaded(): DownloadedUpdate {
    if (!this.downloaded || this.downloading)
      throw new Error('업데이트 파일을 먼저 받아 주세요.');
    if (this.downloaded.dataRoot !== this.options.getDataRoot())
      throw new Error('저장 위치가 바뀌었습니다. 앱을 다시 시작해 주세요.');
    return this.downloaded;
  }
}
