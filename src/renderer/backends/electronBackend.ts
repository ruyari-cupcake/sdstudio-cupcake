import { electronUpdates } from './appUpdates';
import type { SaveLocationInsideInstall } from '../../shared/installDir';
import type { Config } from '../../main/config';
import type {
  EncodeVibeImageInput,
  ImageAugmentInput,
  ImageUpscaleInput,
  ImageGenInput,
  ImageGenService,
  LoginValidity,
} from './imageGen';
import {
  Backend,
  type FileEntry,
  type ResizeImageInput,
  type SelectFileOptions,
} from '../backend';
import { assertDeletableDirPath } from './dataPathGuard';
import { NovelAiImageGenService } from './genVendors/nai';
import { BrowserNovelAiFetcher } from './genVendors/naiTransport';
import { NaiOutcomeUnknownError } from './genVendors/naiErrors';
import type { RecentRequestOptions } from '../models/requestTiming';
import type { ImageContextAlt, SceneContextAlt } from '../models/types';
import { embedSDStudioMetadataInPngBase64 } from '../../shared/sdstudioImageMetadata';
import {
  DRIVE_AUTH_CHANNEL,
  type DriveAuthConnectResult,
  DriveAuthError,
  type DriveAuthStatus,
  isDriveAuthErrorCode,
} from '../../shared/googleDriveAuth';
import {
  DRIVE_FILE_CHANNEL,
  type DriveBackupItem,
  type DriveDownloadIpcResult,
  type DriveDownloadProgress,
  type DriveFileMeta,
  type DriveListIpcResult,
  type DriveListResult,
  type DriveTrashIpcResult,
  DriveUploadError,
  type DriveUploadProgress,
  type DriveUploadResult,
  isDriveUploadErrorCode,
} from '../../shared/googleDrive';

// { ok:false, code, detail } IPC 결과 → DriveUploadError(모르는 코드는 unknown).
function driveFileError(res: any): DriveUploadError {
  const code = res && isDriveUploadErrorCode(res.code) ? res.code : 'unknown';
  return new DriveUploadError(
    code,
    res && typeof res.detail === 'string' ? res.detail : undefined,
  );
}

const invoke = window.electron?.ipcRenderer?.invoke;

/** Native context-menu events exposed by the desktop platform adapter. */
export interface DesktopContextMenuEvents {
  onDuplicateScene(
    callback: (ctx: SceneContextAlt) => void | Promise<void>,
  ): () => void;
  onDuplicateImage(
    callback: (ctx: ImageContextAlt) => void | Promise<void>,
  ): () => void;
  onCopyImage(
    callback: (ctx: ImageContextAlt) => void | Promise<void>,
  ): () => void;
  onMoveSceneFront(
    callback: (ctx: SceneContextAlt) => void | Promise<void>,
  ): () => void;
  onMoveSceneBack(
    callback: (ctx: SceneContextAlt) => void | Promise<void>,
  ): () => void;
}

export class ElectornBackend
  extends Backend
  implements DesktopContextMenuEvents
{
  override readonly updates = electronUpdates();

  private imageGenService: ImageGenService;

  constructor() {
    super();
    this.imageGenService = new NovelAiImageGenService(
      new BrowserNovelAiFetcher(),
      () => this.getConfig(),
    );
  }

  // 로그인 토큰 — 저장 경로(saveLocation)와 무관하게 이 PC 전역(userData,
  // config.json 과 동일 위치)에 보관한다. 종전에는 데이터 루트(APP_DIR)에 있어
  // 저장 경로를 바꾸면 로그인이 풀렸다. 구 위치 토큰은 발견 시 전역으로 1회
  // 이관하고, 원본은 구버전 롤백 호환을 위해 남겨둔다(전역본이 있으면 무시됨).
  private static async readToken(): Promise<string> {
    try {
      return await invoke('read-global-file', 'TOKEN.txt');
    } catch (e: any) {
      if (!String(e?.message || e).includes('ENOENT')) throw e;
      const legacy = await invoke('read-file', 'TOKEN.txt');
      // 부재일 때만 구 위치를 이관한다. 일시 읽기 오류는 위에서 그대로 전파한다.
      // 이관 쓰기 실패는 이번 호출을 막지 않고 다음에 재시도한다.
      try {
        await invoke('write-global-file', 'TOKEN.txt', legacy);
      } catch {
        // Keep the readable legacy credential; migration can be retried on the next read.
      }
      return legacy;
    }
  }

  private static async writeToken(token: string): Promise<void> {
    await invoke('write-global-file', 'TOKEN.txt', token);
  }

  override async readTokenProfileData(): Promise<string | undefined> {
    try {
      return await invoke('read-global-file', 'TOKEN_PROFILES.json');
    } catch (e: any) {
      if (String(e?.message || e).includes('ENOENT')) return undefined;
      throw e;
    }
  }

  override async writeTokenProfileData(data: string): Promise<void> {
    await invoke('write-global-file', 'TOKEN_PROFILES.json', data);
  }

  override async getConfig(): Promise<Config> {
    return await invoke('get-config');
  }

  override async setConfig(newConfig: Config): Promise<void> {
    await invoke('set-config', newConfig);
    this.imageGenService.invalidateConfigCache?.();
  }

  override async changeSaveLocation(absolutePath: string): Promise<void> {
    await invoke('change-save-location', absolutePath);
  }

  override async getVersion(): Promise<string> {
    return await invoke('get-version');
  }

  override async openWebPage(url: string): Promise<void> {
    await invoke('open-web-page', url);
  }

  override async generateImage(arg: ImageGenInput): Promise<void> {
    const token = await ElectornBackend.readToken();
    let res = await this.imageGenService.generateImage(token, arg);
    if (arg.sdstudioMetadata) {
      try {
        res = embedSDStudioMetadataInPngBase64(res, arg.sdstudioMetadata);
      } catch (e) {
        console.warn('SDStudio 생성 메타데이터 삽입 실패(원본 저장):', e);
      }
    }
    // Explicit cancellation remains a boundary; elapsed time never discards a paid result.
    try {
      await this.writeDataFile(arg.outputFilePath, res);
    } catch (error) {
      // Generation already completed; a local persistence failure must not pay for it again.
      throw new NaiOutcomeUnknownError(error);
    }
  }

  override async augmentImage(arg: ImageAugmentInput): Promise<void> {
    const token = await ElectornBackend.readToken();
    const res = await this.imageGenService.augmentImage(token, arg);
    try {
      await this.writeDataFile(arg.outputFilePath, res);
    } catch (error) {
      // Generation already completed; a local persistence failure must not pay for it again.
      throw new NaiOutcomeUnknownError(error);
    }
  }

  override async getRemainCredits(
    options?: RecentRequestOptions,
  ): Promise<number> {
    const token = await ElectornBackend.readToken();
    return await this.imageGenService.getRemainCredits(token, options);
  }

  override async upscaleImage(arg: ImageUpscaleInput): Promise<void> {
    const token = await ElectornBackend.readToken();
    const res = await this.imageGenService.upscaleImage(token, arg);
    try {
      await this.writeDataFile(arg.outputFilePath, res);
    } catch (error) {
      // Generation already completed; a local persistence failure must not pay for it again.
      throw new NaiOutcomeUnknownError(error);
    }
  }

  override async getOpusUsageStatus(options?: RecentRequestOptions) {
    const token = await ElectornBackend.readToken();
    return await this.imageGenService.getOpusUsageStatus(token, options);
  }

  override async getOpusUsageStatusForToken(
    token: string,
    options?: RecentRequestOptions,
  ) {
    return await this.imageGenService.getOpusUsageStatus(token, options);
  }

  override async login(email: string, password: string): Promise<void> {
    const token = await this.imageGenService.login(email, password);
    await ElectornBackend.writeToken(token.accessToken);
  }

  override async loginWithToken(token: string): Promise<void> {
    await ElectornBackend.writeToken(token);
  }

  override async validateToken(token: string): Promise<LoginValidity> {
    return await this.imageGenService.validateToken(token);
  }

  override async validateLogin(): Promise<LoginValidity> {
    let token: string;
    try {
      token = await ElectornBackend.readToken();
    } catch (e: any) {
      return String(e?.message || e).includes('ENOENT') ? 'invalid' : 'error';
    }
    return await this.imageGenService.validateToken(token);
  }

  override async readLoginToken(): Promise<string | undefined> {
    try {
      const token = (await ElectornBackend.readToken()).trim();
      return token || undefined;
    } catch (e: any) {
      if (String(e?.message || e).includes('ENOENT')) return undefined;
      throw e;
    }
  }

  override async encodeVibeImage(arg: EncodeVibeImageInput): Promise<string> {
    const token = await ElectornBackend.readToken();
    return await this.imageGenService.encodeVibeImage(token, arg);
  }

  override async showFile(arg: string): Promise<void> {
    await invoke('show-file', arg);
  }

  override async publishExport(arg: string): Promise<void> {
    await invoke('publish-export', arg);
  }

  override async saveExportToDownloads(arg: string): Promise<string> {
    return await invoke('save-export-to-downloads', arg);
  }

  // ─── Google 드라이브 연동 인증 (드라이브 API ①) — main IPC 위임 ───
  override driveAuthSupported(): boolean {
    return true;
  }

  override async driveAuthStatus(): Promise<DriveAuthStatus> {
    return await invoke(DRIVE_AUTH_CHANNEL.status);
  }

  override async driveAuthConnect(): Promise<DriveAuthStatus> {
    const res: DriveAuthConnectResult = await invoke(
      DRIVE_AUTH_CHANNEL.connect,
    );
    if (res && res.ok) return res.status;
    const code = res && isDriveAuthErrorCode(res.code) ? res.code : 'unknown';
    throw new DriveAuthError(code, res && !res.ok ? res.detail : undefined);
  }

  override async driveAuthCancel(): Promise<void> {
    await invoke(DRIVE_AUTH_CHANNEL.cancel);
  }

  override async driveAuthDisconnect(): Promise<void> {
    await invoke(DRIVE_AUTH_CHANNEL.disconnect);
  }

  override onDriveAuthChanged(
    callback: (status: DriveAuthStatus) => void,
  ): () => void {
    return window.electron.ipcRenderer.on(DRIVE_AUTH_CHANNEL.changed, callback);
  }

  override async driveAuthConnected(): Promise<boolean> {
    return !!(await invoke(DRIVE_AUTH_CHANNEL.connected));
  }

  // PC 는 출처 선택 뒤 input.click() 이 막히지 않아(대화상자 클릭이 사용자 활성화) 쓰지 않는다.
  override driveAuthConnectedHint(): boolean {
    return false;
  }

  // ─── Google 드라이브 올리기 (드라이브 API ②) — main IPC 위임 ───
  // 진행률은 이 창으로만 오는 drive-upload-progress 를 올리기 동안만 구독한다.
  override async driveUpload(
    exportsPath: string,
    meta: { kind: string; name?: string },
    onProgress?: (p: DriveUploadProgress) => void,
  ): Promise<DriveFileMeta> {
    const unsubscribe = onProgress
      ? window.electron.ipcRenderer.on(
          DRIVE_FILE_CHANNEL.uploadProgress,
          (p: any) => {
            if (p && typeof p.sent === 'number' && typeof p.total === 'number')
              onProgress(p);
          },
        )
      : () => {};
    let res: DriveUploadResult;
    try {
      res = await invoke(DRIVE_FILE_CHANNEL.upload, {
        exportsPath,
        kind: meta.kind,
        ...(meta.name ? { name: meta.name } : {}),
      });
    } finally {
      unsubscribe();
    }
    if (res && res.ok) return res.file;
    const code = res && isDriveUploadErrorCode(res.code) ? res.code : 'unknown';
    throw new DriveUploadError(code, res && !res.ok ? res.detail : undefined);
  }

  override async driveUploadCancel(): Promise<void> {
    await invoke(DRIVE_FILE_CHANNEL.uploadCancel);
  }

  override async driveOpenFile(webViewLink: string): Promise<void> {
    await invoke(DRIVE_FILE_CHANNEL.openFile, webViewLink);
  }

  // ─── Google 드라이브 목록·받기·휴지통 (드라이브 API ③) — main IPC 위임 ───
  override async driveList(): Promise<DriveListResult> {
    const res: DriveListIpcResult = await invoke(DRIVE_FILE_CHANNEL.list);
    if (res && res.ok) {
      return {
        items: Array.isArray(res.items) ? res.items : [],
        ...(res.folderLink ? { folderLink: res.folderLink } : {}),
      };
    }
    throw driveFileError(res);
  }

  // 진행률은 이 창으로만 오는 drive-download-progress 를 받기 동안만 구독한다.
  override async driveDownload(
    item: Pick<DriveBackupItem, 'id' | 'name' | 'size'>,
    opts: { toDownloads?: boolean },
    onProgress?: (p: DriveDownloadProgress) => void,
  ): Promise<string> {
    const unsubscribe = onProgress
      ? window.electron.ipcRenderer.on(
          DRIVE_FILE_CHANNEL.downloadProgress,
          (p: any) => {
            if (
              p &&
              typeof p.received === 'number' &&
              typeof p.total === 'number'
            )
              onProgress(p);
          },
        )
      : () => {};
    let res: DriveDownloadIpcResult;
    try {
      res = await invoke(DRIVE_FILE_CHANNEL.download, {
        fileId: item.id,
        name: item.name,
        ...(typeof item.size === 'number' ? { size: item.size } : {}),
        ...(opts.toDownloads ? { toDownloads: true } : {}),
      });
    } finally {
      unsubscribe();
    }
    if (res && res.ok) return res.path;
    throw driveFileError(res);
  }

  override async driveDownloadCancel(): Promise<void> {
    await invoke(DRIVE_FILE_CHANNEL.downloadCancel);
  }

  override async driveTrash(fileId: string): Promise<void> {
    const res: DriveTrashIpcResult = await invoke(DRIVE_FILE_CHANNEL.trash, {
      fileId,
    });
    if (res && res.ok) return;
    throw driveFileError(res);
  }

  override async driveCleanupDownload(fileId: string): Promise<void> {
    try {
      await invoke(DRIVE_FILE_CHANNEL.cleanupDownload, { fileId });
    } catch {
      /* 정리 실패는 무시 */
    }
  }

  override async openPath(arg: string): Promise<void> {
    await invoke('open-path', arg);
  }

  override async copyToDownloads(_path: string): Promise<void> {
    // Android-only callers use this contract; desktop export/show-file owns its OS destination.
  }

  override async zipFiles(files: FileEntry[], outPath: string): Promise<void> {
    await invoke('zip-files', files, outPath);
  }

  override async unzipFiles(zipPath: string, outPath: string): Promise<void> {
    await invoke('unzip-files', zipPath, outPath);
  }

  override async getFreeSpace(): Promise<number | null> {
    return await invoke('get-free-space');
  }

  override async getRuntimeDiag(): Promise<{
    cpus: number;
    uvThreadpool: number;
  } | null> {
    return await invoke('get-runtime-diag');
  }

  override async getBootWarnings(): Promise<{
    saveLocationFallback: { attempted: string; code: string } | null;
    configLoadFailure: { path: string; code: string } | null;
    saveLocationInsideInstall: SaveLocationInsideInstall | null;
  } | null> {
    return await invoke('get-boot-warnings');
  }

  override async getDataRoot(): Promise<string> {
    return await invoke('get-data-root');
  }

  override async backupFailedConfig(): Promise<string> {
    return await invoke('backup-failed-config');
  }

  override async checkWritable(
    absolutePath: string,
  ): Promise<{ ok: boolean; code?: string }> {
    return await invoke('check-writable', absolutePath);
  }

  override async searchTags(word: string, category?: number): Promise<any> {
    return await invoke('search-tags', word, category);
  }

  override async lookupTag(word: string): Promise<any> {
    return await invoke('lookup-tag', word);
  }

  override async loadPiecesDB(pieces: string[]): Promise<void> {
    await invoke('load-pieces-db', pieces);
  }

  override async searchPieces(word: string): Promise<any> {
    return await invoke('search-pieces', word);
  }

  override async listFiles(arg: string): Promise<string[]> {
    return await invoke('list-files', arg);
  }

  override async listFilesWithStats(arg: string): Promise<any[]> {
    return await invoke('list-files-with-stats', arg);
  }

  override async readFile(filename: string): Promise<string> {
    return await invoke('read-file', filename);
  }

  override async writeFile(filename: string, data: string): Promise<void> {
    await invoke('write-file', filename, data);
  }

  override async copyFile(src: string, dest: string): Promise<void> {
    await invoke('copy-file', src, dest);
  }

  override async copyFileToAbsolute(
    src: string,
    absoluteDest: string,
  ): Promise<'copied' | 'same-file'> {
    return await invoke('copy-file-absolute', src, absoluteDest);
  }

  override async convertToWebp(
    src: string,
    dest: string,
    quality: number,
  ): Promise<void> {
    await invoke('convert-to-webp', src, dest, quality);
  }

  override async readDataFile(arg: string): Promise<string> {
    return await invoke('read-data-file', arg);
  }

  override async writeDataFile(filename: string, data: string): Promise<void> {
    await invoke('write-data-file', filename, data);
  }

  override async writeDataFileAbsolute(
    absolutePath: string,
    data: string,
  ): Promise<void> {
    await invoke('write-data-file-absolute', absolutePath, data);
  }

  override async existFileAbsolute(absolutePath: string): Promise<boolean> {
    return await invoke('exist-file-absolute', absolutePath);
  }

  override async renameFile(oldfile: string, newfile: string): Promise<void> {
    await invoke('rename-file', oldfile, newfile);
  }

  override async renameDir(oldfile: string, newfile: string): Promise<void> {
    await invoke('rename-dir', oldfile, newfile);
  }

  override async deleteFile(filename: string): Promise<void> {
    await invoke('delete-file', filename);
  }

  override async deleteDir(filename: string): Promise<void> {
    // 데이터 루트/비정상 경로 삭제 거부 (2026-07-06 outs 전체 증발 사고 방지)
    assertDeletableDirPath(filename);
    await invoke('delete-dir', filename);
  }

  override async trashFile(filename: string): Promise<void> {
    await invoke('trash-file', filename);
  }

  override async close(): Promise<void> {
    await invoke('close');
  }

  override async restartApp(): Promise<void> {
    await invoke('restart-app');
  }

  override async existFile(filename: string): Promise<boolean> {
    return await invoke('exist-file', filename);
  }

  override async download(
    url: string,
    dest: string,
    filename: string,
  ): Promise<void> {
    await invoke('download', url, dest, filename);
  }

  override async resizeImage(input: ResizeImageInput): Promise<void> {
    await invoke('resize-image', input);
  }

  override async openImageEditor(inputPath: string): Promise<void> {
    await invoke('open-image-editor', inputPath);
  }

  override async watchImage(inputPath: string): Promise<void> {
    await invoke('watch-image', inputPath);
  }

  override async unwatchImage(inputPath: string): Promise<void> {
    await invoke('unwatch-image', inputPath);
  }

  override async loadModel(modelPath: string): Promise<void> {
    await invoke('load-model', modelPath);
  }

  override async extractZip(zipPath: string, outPath: string): Promise<void> {
    await invoke('extract-zip', zipPath, outPath);
  }

  override async spawnLocalAI(): Promise<void> {
    await invoke('spawn-local-ai');
  }

  override async isLocalAIRunning(): Promise<boolean> {
    return await invoke('is-local-ai-running');
  }

  override async selectDir() {
    return await invoke('select-dir');
  }

  override async selectFile(options?: SelectFileOptions) {
    // 인자 없는 기존 호출은 그대로(select-file 에 옵션 없이 전달).
    return options
      ? await invoke('select-file', options)
      : await invoke('select-file');
  }

  override async selectFiles(options?: {
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string[]> {
    return await invoke('select-files', options);
  }

  override async readBinaryFile(filePath: string): Promise<string> {
    return await invoke('read-binary-file', filePath);
  }

  override async removeBackground(
    inputImageBase64: string,
    outputPath: string,
  ): Promise<void> {
    await invoke('remove-bg', inputImageBase64, outputPath);
  }

  override async analyzeArtistTags(arg: {
    imageBase64: string;
    model: 'kaloscope' | 'wd-swinv2' | 'wd-eva02';
  }): Promise<any> {
    return await invoke('artist-analyze', arg);
  }

  override onDownloadProgress(
    callback: (progress: any) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('download-progress', callback);
  }

  override onZipProgress(
    callback: (progress: any) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('zip-progress', callback);
  }

  onDuplicateScene(
    callback: (ctx: SceneContextAlt) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('duplicate-scene', callback);
  }

  override onImageChanged(
    callback: (path: string) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('image-changed', callback);
  }

  onDuplicateImage(
    callback: (ctx: ImageContextAlt) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('duplicate-image', callback);
  }

  onCopyImage(
    callback: (ctx: ImageContextAlt) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('copy-image', callback);
  }

  onMoveSceneFront(
    callback: (ctx: SceneContextAlt) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('move-scene-front', callback);
  }

  onMoveSceneBack(
    callback: (ctx: SceneContextAlt) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('move-scene-back', callback);
  }

  override onClose(callback: () => void | Promise<void>): () => void {
    return window.electron.ipcRenderer.on('close', callback);
  }

  override onDanbooruSearch(
    callback: (text: string) => void | Promise<void>,
  ): () => void {
    return window.electron.ipcRenderer.on('danbooru-search', callback);
  }

  override async copyImageToClipboard(imagePath: string): Promise<void> {
    await invoke('copy-image-to-clipboard', imagePath);
  }

  // 새 창 열기(멀티 윈도우 W6) — main 이 보조 창을 캐스케이드 위치로 생성한다.
  // projectName 이 있으면 새 창이 부팅 후 그 프로젝트를 연다("새 창에서 열기").
  override async openNewWindow(projectName?: string): Promise<void> {
    await invoke('open-new-window', projectName);
  }

  // ─── 프로젝트 배타 락 (W6 P1) — main 의 창 간 등록부에 위임 ───
  override async acquireProjectLock(name: string): Promise<boolean> {
    return await invoke('project-lock-acquire', name);
  }

  override async releaseProjectLock(name: string): Promise<void> {
    await invoke('project-lock-release', name);
  }

  override async queryProjectLock(
    name: string,
  ): Promise<{ locked: boolean; mine: boolean }> {
    return await invoke('project-lock-query', name);
  }

  override async focusProjectLockOwner(
    name: string,
    notice?: string,
  ): Promise<void> {
    await invoke('project-lock-focus-owner', name, notice);
  }

  override onLockOwnerNotice(callback: (message: string) => void): () => void {
    return window.electron.ipcRenderer.on('lock-owner-notice', callback);
  }

  override async takeInitialProject(): Promise<string | null> {
    return await invoke('take-initial-project');
  }

  // ─── 전역 저장소 동기화 (W6 P2) ───
  override async notifyGlobalStoreChanged(key: string): Promise<void> {
    await invoke('notify-global-store-changed', key);
  }

  override onGlobalStoreChanged(callback: (key: string) => void): () => void {
    return window.electron.ipcRenderer.on('global-store-changed', callback);
  }

  // ─── 생성 위임: 단일 생성 호스트 (W6 P3) — main 의 창 레지스트리에 위임 ───
  override async isGenerationHost(): Promise<boolean> {
    return await invoke('is-generation-host');
  }

  override onGenerationHostChanged(
    callback: (isHost: boolean) => void,
  ): () => void {
    return window.electron.ipcRenderer.on('generation-host-changed', callback);
  }

  override onGenerationPeerCount(
    callback: (count: number) => void,
  ): () => void {
    return window.electron.ipcRenderer.on('generation-peer-count', callback);
  }

  override async delegateTask(payload: any): Promise<void> {
    await invoke('delegate-task', payload);
  }

  override async delegateCancel(payload: any): Promise<void> {
    await invoke('delegate-cancel', payload);
  }

  override async delegateRun(): Promise<void> {
    await invoke('delegate-run');
  }

  override async delegateStop(): Promise<void> {
    await invoke('delegate-stop');
  }

  override onDelegateTask(callback: (payload: any) => void): () => void {
    return window.electron.ipcRenderer.on('delegate-task', callback);
  }

  override onDelegateCancel(callback: (payload: any) => void): () => void {
    return window.electron.ipcRenderer.on('delegate-cancel', callback);
  }

  override onDelegateRun(callback: () => void): () => void {
    return window.electron.ipcRenderer.on('delegate-run', callback);
  }

  override onDelegateStop(callback: () => void): () => void {
    return window.electron.ipcRenderer.on('delegate-stop', callback);
  }

  override async delegateComplete(payload: any): Promise<void> {
    await invoke('delegate-complete', payload);
  }

  override async delegateQueueSnapshot(snapshot: any): Promise<void> {
    await invoke('delegate-queue-snapshot', snapshot);
  }

  override onDelegateComplete(callback: (payload: any) => void): () => void {
    return window.electron.ipcRenderer.on('delegate-complete', callback);
  }

  override onDelegateQueueSnapshot(
    callback: (snapshot: any) => void,
  ): () => void {
    return window.electron.ipcRenderer.on('delegate-queue-snapshot', callback);
  }

  // ─── 창 간 세션 op(메모리 반영) 동기화 — 읽기 전용 미러 (같은 프로젝트 중복 열기) ───
  override async notifySessionOp(payload: any): Promise<void> {
    await invoke('notify-session-op', payload);
  }

  override onSessionOp(callback: (payload: any) => void): () => void {
    return window.electron.ipcRenderer.on('session-op', callback);
  }
}
