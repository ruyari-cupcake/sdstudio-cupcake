import path from 'path';
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import {
  APP_ID,
  APP_RELEASE_CHANNEL,
  APP_UPDATE_CHANNEL,
} from '../shared/appIdentity';
import { DesktopReleaseUpdater } from './desktopReleaseUpdater';
import {
  prepareWindowsUpdate,
  type PreparedWindowsUpdate,
} from './updateInstaller';

export interface AppUpdateController {
  readonly isInstalling: boolean;
  readonly isDownloading: boolean;
}
export function registerAppUpdate(options: {
  getDataRoot(): string;
  assertCanInstall(): void;
  helperPath: string;
  reopenWindow(): void;
}): AppUpdateController {
  let prepared: PreparedWindowsUpdate | undefined;
  let preparing = false;
  let applying = false;
  let accepted = false;
  let installGeneration = 0;
  const broadcast = (channel: string, value: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, value);
    }
  };
  const failInstall = (message: string) => {
    installGeneration += 1;
    prepared?.cancel();
    prepared = undefined;
    preparing = false;
    applying = false;
    if (BrowserWindow.getAllWindows().length === 0) options.reopenWindow();
    for (const window of BrowserWindow.getAllWindows()) {
      const send = () => {
        if (!window.isDestroyed())
          window.webContents.send('app-update-install-error', message);
      };
      if (window.webContents.isLoading())
        window.webContents.once('did-finish-load', send);
      else send();
    }
  };
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  const updater = new DesktopReleaseUpdater({
    identity: {
      channel: APP_UPDATE_CHANNEL,
      owner: APP_RELEASE_CHANNEL.owner,
      repo: APP_RELEASE_CHANNEL.repo,
      appId: APP_ID,
      version: app.getVersion(),
      kind: portable ? 'windows-portable' : 'windows-folder',
    },
    profileRoot: app.getPath('userData'),
    getDataRoot: options.getDataRoot,
    supported: app.isPackaged && process.platform === 'win32',
    encryptToken: (token) => {
      if (
        !safeStorage.isEncryptionAvailable() ||
        (process.platform === 'linux' &&
          safeStorage.getSelectedStorageBackend() === 'basic_text')
      )
        throw new Error('이 기기에서 연결 정보를 저장할 수 없습니다.');
      return safeStorage.encryptString(token).toString('base64');
    },
    decryptToken: (cipher) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('저장된 연결 정보를 읽을 수 없습니다.');
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    },
    onProgress: (progress) => broadcast('app-update-progress', progress),
  });

  const assertInstall = () => {
    options.assertCanInstall();
    if (!app.isPackaged || process.platform !== 'win32')
      throw new Error('설치한 Windows 앱에서 업데이트해 주세요.');
    if (
      BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
        .length !== 1
    )
      throw new Error('다른 SDStudio 창을 닫은 뒤 업데이트해 주세요.');
  };

  ipcMain.handle(
    'app-update',
    async (_event, operation: string, value?: string) => {
      switch (operation) {
        case 'state':
          return updater.getState();
        case 'claim-startup':
          return updater.claimStartupCheck();
        case 'check':
          return updater.check();
        case 'snooze':
          return updater.snooze();
        case 'connect':
          return updater.connect(value ?? '');
        case 'disconnect':
          return updater.disconnect();
        case 'download':
          return updater.download(value ?? '');
        case 'cancel-download':
          return updater.cancelDownload();
        case 'cancel-install':
          if (applying || accepted)
            throw new Error('설치를 시작해서 지금은 취소할 수 없습니다.');
          if (!accepted && (preparing || prepared))
            failInstall('저장을 마친 뒤 다시 업데이트해 주세요.');
          return undefined;
        case 'install': {
          if (preparing || prepared || applying)
            throw new Error('업데이트 설치를 준비하고 있습니다.');
          assertInstall();
          const downloaded = updater.getDownloaded();
          preparing = true;
          const generation = ++installGeneration;
          try {
            const helper = await prepareWindowsUpdate({
              channel: APP_UPDATE_CHANNEL,
              kind: portable ? 'portable' : 'folder',
              artifact: {
                path: downloaded.artifactPath,
                sha256: downloaded.release.asset.sha256,
                size: downloaded.release.asset.size,
              },
              target: {
                path: portable || path.dirname(process.execPath),
                appId: APP_ID,
                executable: path.basename(portable || process.execPath),
              },
              dataRoot: downloaded.dataRoot,
              helperPath: options.helperPath,
              onError: (error) => {
                if (!accepted && generation === installGeneration)
                  failInstall(error.message);
              },
            });
            try {
              if (generation !== installGeneration)
                throw new Error('업데이트 설치를 취소했습니다.');
              assertInstall();
            } catch (error) {
              helper.cancel();
              throw error;
            }
            prepared = helper;
            preparing = false;
            // Each window follows the existing renderer save/close acknowledgement.
            for (const window of BrowserWindow.getAllWindows()) window.close();
            return undefined;
          } catch (error) {
            if (generation === installGeneration) {
              preparing = false;
              prepared?.cancel();
              prepared = undefined;
            }
            throw error;
          }
        }
        default:
          throw new Error('알 수 없는 업데이트 요청입니다.');
      }
    },
  );

  app.on('will-quit', (event) => {
    if (!prepared || accepted) return;
    event.preventDefault();
    if (applying) return;
    applying = true;
    const pending = prepared;
    const generation = installGeneration;
    void pending
      .apply()
      .then(() => {
        accepted = true;
        app.quit();
        return undefined;
      })
      .catch((error: unknown) => {
        if (generation !== installGeneration || prepared !== pending) return;
        failInstall(
          error instanceof Error
            ? error.message
            : '업데이트를 시작하지 못했습니다.',
        );
      });
  });

  return {
    get isInstalling() {
      return preparing || Boolean(prepared) || applying;
    },
    get isDownloading() {
      return updater.isDownloading;
    },
  };
}
