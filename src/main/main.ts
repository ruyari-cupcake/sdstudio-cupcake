/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
// 반드시 최상단 — sharp/첫 threadpool 사용 전에 UV_THREADPOOL_SIZE 를 확정한다.
import './uvThreadpool';
// 개발 실행에서만 .env 를 읽는다 — googleDrive(클라이언트 값)를 불러오는 모듈보다 먼저 둔다.
import './devDotEnv';
import path from 'path';
import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  screen,
  dialog,
  nativeImage,
  clipboard,
  ClipboardItem,
} from 'electron';
import log from 'electron-log';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import fsExtra from 'fs-extra';
import contextMenu from 'electron-context-menu';
import * as electronDL from 'electron-dl';

import { ImageWatchService } from './imageWatchService';
import { createDataStorageHandler } from './dataStorageGate';
import { resolvePreloadPath } from './preloadPath';
import { attachRendererRecovery } from './rendererRecovery';
import { APP_NAME } from '../shared/appIdentity';
import {
  registerAppUpdate,
  type AppUpdateController,
} from './registerAppUpdate';
import { copyFileUnlessSame } from './copyFileUnlessSame';
import { openExportDirectory } from './openExportDirectory';
import { writeImageZip } from './writeImageZip';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';

import webpackPaths from '../../.erb/configs/webpack.paths';
import type { Config } from './config';
import { backupFailedConfig, loadJsonConfig } from './configLoad';
import { extractStealthBits, embedStealthBits, canEmbed } from './stealth';
import LocalAIService from './localai';

import { ImageOptimizeMethod } from '../renderer/backend';
import { ModelVersion } from '../renderer/backends/imageGen';
import { OUTPUT_IMAGE_EXTS } from '../renderer/models/imageFormats';
import {
  embedSDStudioMetadataInWebpBytes,
  extractSDStudioMetadataFromBase64,
  type SDStudioImageMetadataV1,
} from '../shared/sdstudioImageMetadata';
import { isV5ModelVersion } from '../renderer/backends/genVendors/naiModelCapabilities';
import * as googleDriveAuth from './googleDrive';
import { uploadExportFileForIpc } from './googleDrive/upload';
import {
  cleanupDriveDownload,
  downloadDriveFileForIpc,
} from './googleDrive/download';
import { listBackupsForIpc, trashBackupFileForIpc } from './googleDrive/manage';
import { DRIVE_AUTH_CHANNEL } from '../shared/googleDriveAuth';
import { DRIVE_FILE_CHANNEL, isDriveWebUrl } from '../shared/googleDrive';
import {
  INSIDE_INSTALL_DIR_CODE,
  type SaveLocationInsideInstall,
} from '../shared/installDir';
import { isSameOrInside, resolveInstallDir } from './installDirGuard';

const fsSync = require('fs');
const fs = require('fs').promises;
const os = require('os');

const sharp = require('sharp');
// 대량 병렬 변환 최적화: 각 sharp 연산이 libvips 스레드를 코어 수만큼 점유하면,
// worker-pool 이 N장을 동시에 돌릴 때 N×코어 스레드가 경합해(오버서브스크립션)
// 오히려 느려진다. 연산당 1스레드로 두고 "여러 장을 동시에"(UV_THREADPOOL_SIZE)
// 병렬화하는 것이 다수 이미지 처리에 유리하다(sharp 공식 권장). 트랙2 WebP Phase 2.
sharp.concurrency(1);
// vips 연산 캐시 비활성 — 캐시가 입력 파일(특히 webp: mmap 유지)을 잡아 두면
// Windows 에서 해당 파일 rename/unlink 가 EBUSY 로 실패한다(휴지통 미삭제 버그).
// 썸네일은 fastcache(디스크)로 이미 캐싱되므로 vips 메모리 캐시의 실익도 없다.
sharp.cache(false);
const ExifReader = require('exifreader');
const native = require('sdsnative');
const { exiftool } = require('exiftool-vendored');
const chokidar = require('chokidar');

const AsyncStreamZip = require('node-stream-zip').async;

interface DataBaseConns {
  tagDBId: number;
  pieceDBId: number;
}

const databases: DataBaseConns = {
  tagDBId: -1,
  pieceDBId: -1,
};

// 주 창(primary) 포인터 — 창 상태 저장/second-instance 포커스의 기준이 된다.
// 보조 창은 이 변수에 담기지 않고 BrowserWindow.getAllWindows() 로만 추적한다(W6 P0).
let mainWindow: BrowserWindow | null = null;
let tagMap: Map<string, any> = new Map();
type TagDatabaseKind = 'legacy' | 'v5';
let activeTagDatabase: TagDatabaseKind | undefined;
let tagDatabaseLoadPromise: Promise<void> = Promise.resolve();

// 종료 저장 게이트 — 창별로 분리(webContents.id 기준). 닫는 창만 렌더러에 저장을
// 위임받고, 렌더러가 invoke('close') 하면 그 창만 다시 닫는다. 창이 닫히면 정리한다.
// (전역 단일 플래그였다면 한 창을 닫을 때 다른 창의 저장 게이트까지 함께 열려 유실 위험)
const saveCompletedByWc = new Map<number, boolean>();

// 전 창 브로드캐스트 — 요청 컨텍스트가 없는(창 공유) 이벤트용. 파괴된 창은 건너뛴다.
function broadcast(channel: string, ...args: any[]) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

// ─── 프로젝트 배타 락 (W6 P1) ───
// 같은 프로젝트를 두 창에서 동시에 여는 것을 원천 차단한다. 렌더러의 쓰기 큐/락은
// 프로세스(창) 내부 직렬화라 창 간에는 효력이 없어, 이 등록부가 유일한 안전선이다.
// 키 = 프로젝트명, 값 = 소유 창 webContents.id. 창이 닫히면 자동 해제(closed 훅).
const projectLocks = new Map<string, number>();

function findWindowByWcId(wcId: number): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.webContents.id === wcId,
  );
}

// 소유 창이 이미 사라진 낡은 락은 지우고 없는 것으로 취급한다(방어적 자가 치유).
function liveLockOwner(name: string): number | undefined {
  const owner = projectLocks.get(name);
  if (owner === undefined) return undefined;
  if (!findWindowByWcId(owner)) {
    projectLocks.delete(name);
    return undefined;
  }
  return owner;
}

ipcMain.handle('project-lock-acquire', (event, name: string) => {
  const owner = liveLockOwner(name);
  if (owner === undefined || owner === event.sender.id) {
    projectLocks.set(name, event.sender.id);
    return true;
  }
  return false;
});

ipcMain.handle('project-lock-release', (event, name: string) => {
  if (projectLocks.get(name) === event.sender.id) projectLocks.delete(name);
});

ipcMain.handle('project-lock-query', (event, name: string) => {
  const owner = liveLockOwner(name);
  if (owner === undefined) return { locked: false, mine: false };
  return { locked: true, mine: owner === event.sender.id };
});

// 락 소유 창을 앞으로 가져온다 — "다른 창에서 열려 있음" 충돌 UX용.
// notice 가 있으면 안내 토스트를 **소유 창**에 띄운다 — 포커스가 즉시 소유 창으로
// 넘어가므로 요청한 창에 토스트를 남기면 돌아왔을 때 낡은 메시지만 남는다(실기 피드백).
ipcMain.handle(
  'project-lock-focus-owner',
  (_event, name: string, notice?: string) => {
    const owner = liveLockOwner(name);
    if (owner === undefined) return false;
    const win = findWindowByWcId(owner);
    if (!win) return false;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (notice) win.webContents.send('lock-owner-notice', notice);
    return true;
  },
);

// ─── 전역 저장소 동기화 (W6 P2) ───
// 창 공유 저장소(config·글로벌 캐릭터 프리셋·휴지통·세션 메타)의 변경을 다른
// 창들에 알린다 — 낙관적 쓰기 + 변경 브로드캐스트(수신 창이 디스크에서 재로드).
// 보낸 창 자신은 제외한다(이미 최신 상태 + 재로드로 인한 편집 중 상태 유실 방지).
function broadcastGlobalStoreChanged(senderWcId: number, key: string) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.id !== senderWcId) {
      w.webContents.send('global-store-changed', key);
    }
  }
}

ipcMain.handle('notify-global-store-changed', (event, key: string) => {
  broadcastGlobalStoreChanged(event.sender.id, key);
});

// ─── 창 간 세션 op(메모리 반영) 동기화 — 읽기 전용 미러 (같은 프로젝트 중복 열기) ───
// P2 의 저장소 재로드 브로드캐스트와 의미론이 다르다: 저장소를 다시 읽는 게 아니라
// 메모리의 세션 op(이미지 즐겨찾기 등)를 다른 창에 그대로 전달해, 로드된 창이 op 를
// 적용하도록 한다(소유 창이면 자기 큐가 저장, 미러 창은 P0 가드가 저장을 드롭).
// 보낸 창 자신은 제외한다(이미 로컬 반영됨). P2 broadcastGlobalStoreChanged 와 동형.
ipcMain.handle('notify-session-op', (event, payload: any) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.id !== event.sender.id) {
      w.webContents.send('session-op', payload);
    }
  }
});

// "새 창에서 열기"로 전달된 초기 프로젝트 — 새 창(wcId)이 부팅 후 1회 가져간다.
const pendingInitialProject = new Map<number, string>();

ipcMain.handle('take-initial-project', (event) => {
  const name = pendingInitialProject.get(event.sender.id) ?? null;
  pendingInitialProject.delete(event.sender.id);
  return name;
});

// ─── 생성 위임: 단일 생성 호스트 (W6 P3) ───
// 모든 창의 생성 예약/실행을 "생성 호스트" 창 하나의 큐에서 처리한다. 기본 호스트는
// 첫(주) 창. 보조 창의 큐는 항상 비어 있고 제출/실행/취소를 IPC 로 호스트에 위임하며,
// 완료·상태는 역방향으로 브리지된다. 호스트가 닫히면 남은 창 중 가장 오래된 창으로
// 승격한다. 단일 창(=호스트 자신)·모바일은 위임 경로를 아예 타지 않아 종전과 동일하다.
let generationHostWcId: number | null = null;

function hostWindow(): BrowserWindow | undefined {
  if (generationHostWcId == null) return undefined;
  return findWindowByWcId(generationHostWcId);
}

// 호스트 창에 "보조 창 수"를 알린다 — 0이면 호스트가 상태 스냅샷 브로드캐스트를
// 생략하므로 단일 창에서는 위임 관련 추가 작업이 전혀 없다(최우선 회귀 기준).
function notifyPeerCount() {
  const host = hostWindow();
  if (!host) return;
  const peers = BrowserWindow.getAllWindows().filter(
    (w) => !w.isDestroyed() && w.webContents.id !== generationHostWcId,
  ).length;
  host.webContents.send('generation-peer-count', peers);
}

// 각 창에 자신이 호스트인지 통지한다(승격·역할 변경 시). 최초 배정 시점의 렌더러는
// 아직 리스너 등록 전일 수 있으나, 렌더러가 부팅 시 is-generation-host 로 직접
// 조회(pull)하므로 타이밍에 무관하게 정확한 역할을 얻는다.
function broadcastHostRole() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send(
        'generation-host-changed',
        w.webContents.id === generationHostWcId,
      );
    }
  }
}

ipcMain.handle('is-generation-host', (event) => {
  return event.sender.id === generationHostWcId;
});

// 보조 창 → 호스트: 태스크 제출 위임. originWindowId 는 main 이 신뢰 가능한 출처인
// event.sender 로 주입한다(렌더러가 자기 wcId 를 알 필요 없음).
ipcMain.handle('delegate-task', (event, payload: any) => {
  hostWindow()?.webContents.send('delegate-task', {
    ...payload,
    originWindowId: event.sender.id,
  });
});

ipcMain.handle('delegate-cancel', (event, payload: any) => {
  hostWindow()?.webContents.send('delegate-cancel', {
    ...payload,
    originWindowId: event.sender.id,
  });
});

// 시작/정지는 전역(호스트 큐 전체) — 사용자 합의(보조 창도 실행/정지 가능, 단순화).
ipcMain.handle('delegate-run', () => {
  hostWindow()?.webContents.send('delegate-run');
});
ipcMain.handle('delegate-stop', () => {
  hostWindow()?.webContents.send('delegate-stop');
});

// 호스트 → 원 창: 이미지 1장 완료/실패 브리지(imageMap 갱신·onComplete 대행·토스트).
ipcMain.handle('delegate-complete', (_event, payload: any) => {
  findWindowByWcId(payload.originWindowId)?.webContents.send(
    'delegate-complete',
    payload,
  );
});

// 호스트 → 보조 창들: 큐 상태 미러 스냅샷(호스트 자신 제외). 단일 출처라 합산 불필요.
ipcMain.handle('delegate-queue-snapshot', (event, snapshot: any) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.id !== event.sender.id) {
      w.webContents.send('delegate-queue-snapshot', snapshot);
    }
  }
});

// 살아있는 창 하나(주 창 우선)를 복원·포커스한다. second-instance 처리용.
function focusAnyWindow() {
  const win =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
}

async function listFilesInDirectory(dir: any) {
  try {
    const files = await fs.readdir(dir);
    return files; // Return the list of files
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

// Function to get the MIME type based on file extension
function getMimeType(filePath: any) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
      return 'text/plain';
    case '.html':
      return 'text/html';
    default:
      return 'application/octet-stream';
  }
}

// Function to read file as Data URL
async function readFileAsDataURL(filePath: any) {
  try {
    const data = await fs.readFile(filePath);
    const mimeType = getMimeType(filePath);
    const base64Data = data.toString('base64');
    const dataURL = `data:${mimeType};base64,${base64Data}`;
    return dataURL;
  } catch (err) {
    console.error('Error reading file:', err);
    throw err;
  }
}

app.setName(APP_NAME);
const DEFAULT_APP_DIR = `${app.getPath('userData')}/SDStudio`;
let APP_DIR = DEFAULT_APP_DIR;
// 프로그램 설치 폴더(패키징된 실행 파일이 있는 폴더). 개발 실행은 null.
const INSTALL_DIR = resolveInstallDir(app.isPackaged, process.execPath);

let config: Config = {};
let configLoadFailure: { path: string; code: string } | null = null;

// Historical IPC field name retained for compatibility. A failed selected root
// blocks user-data IO and boot; it never falls back to another data directory.
let saveLocationFallback: { attempted: string; code: string } | null = null;
// 최종 데이터 루트(APP_DIR)가 설치 폴더와 같거나 그 아래일 때 채워진다. 업데이트 설치 때
// 삭제될 수 있으므로 렌더러가 부팅 후 1회 경고한다. 저장 경로는 자동으로 바꾸지 않는다
// (데이터를 그대로 두고 사용자가 환경설정에서 옮기게 한다).
let saveLocationInsideInstall: SaveLocationInsideInstall | null = null;
let storageRestartPending: string | null = null;
// Per-window transfer owners also participate in storage-transition admission.
const driveUploads = new Map<number, AbortController>();
const driveDownloads = new Map<number, AbortController>();
let appUpdateController: AppUpdateController | undefined;

// Root-dependent handlers share the same gate, so even a missing-directory
// listing cannot masquerade as an empty project store after a failed boot.
const dataStorageError = () => {
  if (configLoadFailure)
    return '설정 파일을 읽을 수 없어 저장소를 열지 않았습니다.';
  if (saveLocationFallback)
    return `저장 폴더에 접근할 수 없습니다: ${saveLocationFallback.attempted} (${saveLocationFallback.code})`;
  if (storageRestartPending) return '저장 위치 변경 후 다시 시작해야 합니다.';
  return undefined;
};
const handleData = createDataStorageHandler(
  ipcMain.handle.bind(ipcMain),
  dataStorageError,
);

// 창 컨트롤 IPC — 호출한 창(event.sender)에만 작용한다(멀티 윈도우 안전).
ipcMain.handle('window-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.handle('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) {
    win.unmaximize();
  } else {
    win?.maximize();
  }
});
ipcMain.handle('window-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
ipcMain.handle('window-is-maximized', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});
ipcMain.handle('get-config', async (_event) => {
  return config;
});

// Serialize the whole commit across windows, including model activation and rollback.
// A rejected save must not poison the next explicit retry.
let configSavePromise: Promise<void> = Promise.resolve();
function saveConfig(
  senderId: number,
  candidate: (current: Config) => Config,
): Promise<void> {
  const save = configSavePromise.then(async () => {
    const previousConfig = config;
    const newConfig = candidate(previousConfig);
    const tmpFile = path.join(DEFAULT_APP_DIR, uuidv4());
    try {
      // Keep the authoritative memory snapshot until the atomic replacement succeeds.
      await fs.writeFile(tmpFile, JSON.stringify(newConfig), 'utf-8');
      await loadTagDatabase(newConfig.modelVersion);
      try {
        await fs.rename(tmpFile, path.join(DEFAULT_APP_DIR, 'config.json'));
      } catch (error) {
        // Model activation belongs to the same save; retain the previous model on failure.
        try {
          await loadTagDatabase(previousConfig.modelVersion);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            '설정 저장 및 모델 복원에 실패했습니다.',
          );
        }
        throw error;
      }
      config = newConfig;
    } finally {
      // Delete only this save's temporary file. Cleanup must not replace the real outcome.
      try {
        await fs.rm(tmpFile, { force: true });
      } catch (error) {
        log.warn('설정 임시 파일 정리 실패:', error);
      }
    }
    try {
      broadcastGlobalStoreChanged(senderId, 'config');
    } catch (error) {
      // The disk commit is complete even if another window disappears before notification.
      log.warn('저장된 설정의 창 알림 실패:', error);
    }
  });
  configSavePromise = save.catch(() => undefined);
  return save;
}

ipcMain.handle('set-config', (event, newConfig: Config) => {
  return saveConfig(event.sender.id, (current) => {
    if (storageRestartPending)
      throw new Error('저장 위치 변경 후 다시 시작해야 합니다.');
    // Ordinary settings snapshots cannot undo a storage transition or bypass its
    // flush/restart ownership. Only change-save-location owns this field.
    const next = { ...newConfig };
    if (Object.prototype.hasOwnProperty.call(current, 'saveLocation')) {
      next.saveLocation = current.saveLocation;
    } else {
      delete next.saveLocation;
    }
    return next;
  });
});

ipcMain.handle('change-save-location', async (event, absolutePath: string) => {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath))
    throw new Error('절대 경로의 폴더를 선택해주세요.');
  if (configLoadFailure)
    throw new Error(
      '기존 설정 파일을 읽을 수 없어 저장 위치를 변경할 수 없습니다.',
    );
  const target = path.resolve(absolutePath);
  const validateWindow = () => {
    if (appUpdateController?.isDownloading || appUpdateController?.isInstalling)
      throw new Error('업데이트가 끝난 뒤 저장 위치를 변경해 주세요.');
    if (driveUploads.size > 0 || driveDownloads.size > 0)
      throw new Error('드라이브 파일 전송이 끝난 뒤 저장 위치를 변경해주세요.');
    if (
      BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
        .length !== 1
    )
      throw new Error('다른 SDStudio 창을 닫은 뒤 저장 위치를 변경해주세요.');
    if (storageRestartPending)
      throw new Error('이미 저장 위치를 변경했습니다. 앱을 다시 시작해주세요.');
  };
  validateWindow();
  const check = await checkWritableFolder(target);
  if (!check.ok) {
    throw new Error(
      check.code === INSIDE_INSTALL_DIR_CODE
        ? '프로그램 설치 폴더 안은 저장 위치로 사용할 수 없습니다.'
        : `선택한 폴더에 쓸 수 없습니다. (${check.code})`,
    );
  }
  await saveConfig(event.sender.id, (current) => {
    validateWindow();
    return { ...current, saveLocation: target };
  });
  // Renderer has flushed its owned data before this commit. Block subsequent
  // user-data IPC until the next process reads the new root; never hot-switch
  // live projects or report the target as active in this process.
  storageRestartPending = target;
});

ipcMain.handle('get-version', async (_event) => {
  return app.getVersion();
});

// 런타임 진단(트랙2 WebP): 감지 코어 수와 실효 libuv 스레드풀 크기(=동시 인코딩
// 상한)를 노출한다. 환경설정 시스템 탭에서 병렬 상한이 실제로 코어 수로 잡혔는지
// 사용자가 눈으로 확인하는 용도.
ipcMain.handle('get-runtime-diag', async () => {
  return {
    cpus: require('os').cpus().length,
    uvThreadpool: process.env.UV_THREADPOOL_SIZE
      ? parseInt(process.env.UV_THREADPOOL_SIZE, 10)
      : 4,
  };
});

// 부팅 경고 조회: 설정 파일 읽기 실패 또는 사용자 지정 저장 경로 접근 실패를
// 렌더러에 전달한다. 렌더러는 사용자 데이터 IO 전에 조회해 전면 가드로 안내한다.
ipcMain.handle('get-boot-warnings', async () => {
  return { saveLocationFallback, configLoadFailure, saveLocationInsideInstall };
});

ipcMain.handle('get-data-root', async () => APP_DIR);

// 설정 파일 영구 파손 시 탈출 경로. 원본은 삭제하지 않고 같은 폴더의 고유 백업명으로
// 이동한다. 이후 재시작하면 config.json 부재=최초 설정으로 안전하게 부팅한다.
ipcMain.handle('backup-failed-config', async () => {
  if (!configLoadFailure) {
    throw new Error('복구할 설정 파일 오류가 없습니다.');
  }
  const expectedPath = path.join(DEFAULT_APP_DIR, 'config.json');
  if (path.resolve(configLoadFailure.path) !== path.resolve(expectedPath)) {
    throw new Error('설정 파일 경로가 올바르지 않습니다.');
  }
  return await backupFailedConfig(expectedPath);
});

// 저장 경로 사전 검증: 사용자가 폴더를 저장 경로로 지정하기 전에 실제 쓰기 가능
// 여부를 확인한다(권한 없는 드라이브 지정 → 다음 부팅 벽돌화 예방). 데스크톱 전용.
async function checkWritableFolder(
  absPath: string,
): Promise<{ ok: boolean; code?: string }> {
  // 설치 폴더(또는 그 하위)는 쓰기 가능해도 거부한다 — 업데이트 설치가 설치 폴더의 파일을
  // 교체하면서 데이터가 삭제될 수 있다. 쓰기 검사(폴더 생성)보다 먼저 판정한다.
  if (INSTALL_DIR && isSameOrInside(absPath, INSTALL_DIR)) {
    return { ok: false, code: INSIDE_INSTALL_DIR_CODE };
  }
  try {
    await fs.mkdir(absPath, { recursive: true });
    const probe = path.join(absPath, `.${uuidv4()}.wtest`);
    await fs.writeFile(probe, 'ok', 'utf-8');
    await fs.rm(probe).catch(() => {});
    return { ok: true };
  } catch (e: any) {
    return { ok: false, code: String(e?.code || e?.message || e) };
  }
}

ipcMain.handle('check-writable', async (_event, absPath: string) =>
  checkWritableFolder(absPath),
);

ipcMain.handle('open-web-page', async (_event, url) => {
  await shell.openExternal(url);
});

// ─── Google 드라이브 연동 인증 (드라이브 API ①) ───
// 상태는 main(googleDrive 모듈) 하나가 진실이다. renderer 에는 DriveAuthStatus 만 보내고
// 토큰·시크릿은 넘기지 않는다. 변경은 모듈이 전 창에 drive-auth-changed 로 알린다.
ipcMain.handle(DRIVE_AUTH_CHANNEL.status, async () =>
  googleDriveAuth.getStatus(),
);
ipcMain.handle(DRIVE_AUTH_CHANNEL.connect, async () =>
  googleDriveAuth.connectForIpc(),
);
ipcMain.handle(DRIVE_AUTH_CHANNEL.configure, async () =>
  googleDriveAuth.configureClientForIpc(),
);
ipcMain.handle(DRIVE_AUTH_CHANNEL.cancel, async () =>
  googleDriveAuth.cancelConnect(),
);
ipcMain.handle(DRIVE_AUTH_CHANNEL.disconnect, async () =>
  googleDriveAuth.disconnect(),
);
// 연결 여부만(네트워크 조회 없음) — 내보내기 목적지 결정용(드라이브 API ②).
ipcMain.handle(DRIVE_AUTH_CHANNEL.connected, async () =>
  googleDriveAuth.isConnected(),
);

// ─── Google 드라이브 올리기 (드라이브 API ②) ───
// 창(webContents)마다 한 번에 하나. 진행률은 요청한 창에만 보내고, 창이 닫히면 올리기를 중단한다.
// 경로는 publish-export 와 같은 규칙(APP_DIR 기준 exports/… 만). 토큰 파일은 main 에서도 거부.
handleData(DRIVE_FILE_CHANNEL.upload, async (event, request) => {
  const { sender } = event;
  const senderId = sender.id;
  if (driveUploads.has(senderId)) return { ok: false, code: 'busy' };
  const controller = new AbortController();
  driveUploads.set(senderId, controller);
  const onDestroyed = () => controller.abort();
  sender.once('destroyed', onDestroyed);
  try {
    return await uploadExportFileForIpc({
      appDir: APP_DIR,
      request,
      signal: controller.signal,
      onProgress: (p) => {
        if (!sender.isDestroyed())
          sender.send(DRIVE_FILE_CHANNEL.uploadProgress, p);
      },
    });
  } finally {
    if (driveUploads.get(senderId) === controller)
      driveUploads.delete(senderId);
    if (!sender.isDestroyed()) sender.removeListener('destroyed', onDestroyed);
  }
});
ipcMain.handle(DRIVE_FILE_CHANNEL.uploadCancel, async (event) => {
  driveUploads.get(event.sender.id)?.abort();
});
// 드라이브 웹 주소(https://drive.google.com/…)만 시스템 브라우저로 연다.
ipcMain.handle(DRIVE_FILE_CHANNEL.openFile, async (_event, url) => {
  if (!isDriveWebUrl(url)) throw new Error('Google 드라이브 주소가 아닙니다.');
  await shell.openExternal(url);
});

// ─── Google 드라이브 목록·받기·휴지통 (드라이브 API ③) ───
// 받기는 창마다 한 번에 하나(진행률은 요청 창에만, 창이 닫히면 중단). 기본 목적지는
// APP_DIR/tmp/drive-download/<fileId>/ — 불러오기가 끝나면 renderer 가 drive-cleanup-download 로
// 지운다. 삭제는 드라이브 휴지통 이동만(files.delete 는 어디에서도 호출하지 않는다).
ipcMain.handle(DRIVE_FILE_CHANNEL.list, async () => listBackupsForIpc());
handleData(DRIVE_FILE_CHANNEL.download, async (event, request) => {
  const { sender } = event;
  const senderId = sender.id;
  if (driveDownloads.has(senderId)) return { ok: false, code: 'busy' };
  const controller = new AbortController();
  driveDownloads.set(senderId, controller);
  const onDestroyed = () => controller.abort();
  sender.once('destroyed', onDestroyed);
  try {
    return await downloadDriveFileForIpc({
      appDir: APP_DIR,
      downloadsDir: app.getPath('downloads'),
      request,
      signal: controller.signal,
      onProgress: (p) => {
        if (!sender.isDestroyed())
          sender.send(DRIVE_FILE_CHANNEL.downloadProgress, p);
      },
    });
  } finally {
    if (driveDownloads.get(senderId) === controller)
      driveDownloads.delete(senderId);
    if (!sender.isDestroyed()) sender.removeListener('destroyed', onDestroyed);
  }
});
ipcMain.handle(DRIVE_FILE_CHANNEL.downloadCancel, async (event) => {
  driveDownloads.get(event.sender.id)?.abort();
});
ipcMain.handle(DRIVE_FILE_CHANNEL.trash, async (_event, request) =>
  trashBackupFileForIpc(request?.fileId),
);
handleData(DRIVE_FILE_CHANNEL.cleanupDownload, async (_event, request) => {
  await cleanupDriveDownload(APP_DIR, request?.fileId);
});

// 종료 시 브라우저 승인 대기(루프백 서버·타이머)와 진행 중인 올리기·받기를 정리한다.
app.on('will-quit', () => {
  googleDriveAuth.cancelConnect();
  for (const c of driveUploads.values()) c.abort();
  for (const c of driveDownloads.values()) c.abort();
});

handleData('show-file', async (_event, arg) => {
  // 절대경로(목표 폴더 export 결과)면 그대로, 아니면 APP_DIR 기준 상대경로로 해석.
  const filePath = path.resolve(APP_DIR, arg);
  shell.showItemInFolder(filePath);
});

// 폴더를 OS 파일 탐색기로 연다(내용물 표시 — show-file 은 부모에서 선택만 함).
// 프로젝트 우클릭 "파일 탐색기에서 열기"용. shell.openPath 는 실패 시 throw 대신
// 오류 문자열을 반환하므로 명시적으로 승격한다.
handleData('open-path', async (_event, arg) => {
  await openExportDirectory(path.resolve(APP_DIR, arg), (target) =>
    shell.openPath(target),
  );
});

const tar = require('tar-fs');
const tarStream = require('tar-stream');

// 사용자 내보내기만 앱 내부 exports/에서 OS 다운로드 폴더로 이동한다.
// 마이그레이션 사전 백업은 이 IPC를 호출하지 않으므로 기존 exports/에 남아
// 재시작 시 완성 백업 재사용 판정에 계속 쓰인다.
// publish-export(이동 후 폴더 열기)와 save-export-to-downloads(이동만 — 프로젝트
// 덮어쓰기 임시 백업, 드라이브 동기화 ⑤)가 같은 이동 규칙을 공유한다.
async function moveExportToDownloads(
  arg: unknown,
): Promise<{ destination: string; isDirectory: boolean }> {
  if (typeof arg !== 'string')
    throw new Error('내보내기 경로가 올바르지 않습니다.');
  const normalized = arg.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized.startsWith('exports/') || normalized.includes('../')) {
    throw new Error('내보내기 폴더 밖의 파일은 이동할 수 없습니다.');
  }

  const exportRoot = path.resolve(APP_DIR, 'exports');
  const source = path.resolve(APP_DIR, normalized);
  const sourceRel = path.relative(exportRoot, source);
  if (!sourceRel || sourceRel.startsWith('..') || path.isAbsolute(sourceRel)) {
    throw new Error('내보내기 경로가 올바르지 않습니다.');
  }

  const stat = await fs.stat(source);
  const downloads = app.getPath('downloads');
  await fs.mkdir(downloads, { recursive: true });
  const parsed = path.parse(path.basename(source));
  const outputStem = stat.isDirectory() ? parsed.base : parsed.name;
  const outputExt = stat.isDirectory() ? '' : parsed.ext;
  let destination = path.join(downloads, parsed.base);
  let suffix = 1;
  for (;;) {
    try {
      await fs.access(destination);
      destination = path.join(
        downloads,
        `${outputStem} (${suffix++})${outputExt}`,
      );
    } catch (e: any) {
      if (e?.code === 'ENOENT') break;
      throw e;
    }
  }

  try {
    await fs.rename(source, destination);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await fsExtra.copy(source, destination, {
      overwrite: false,
      errorOnExist: true,
    });
    await fsExtra.remove(source);
  }
  return { destination, isDirectory: stat.isDirectory() };
}

handleData('publish-export', async (_event, arg) => {
  const { destination, isDirectory } = await moveExportToDownloads(arg);
  await openExportDirectory(
    isDirectory ? destination : path.dirname(destination),
    (target) => shell.openPath(target),
  );
});

// 대화상자·폴더 열기 없이 다운로드 폴더로 옮기기만 하고 최종 절대 경로를 돌려준다.
handleData('save-export-to-downloads', async (_event, arg) => {
  const { destination } = await moveExportToDownloads(arg);
  return destination;
});

handleData('zip-files', async (event, inputFiles, outPath) => {
  if (path.extname(outPath).toLowerCase() === '.zip') {
    return await writeImageZip(
      inputFiles.map((file: any) => ({
        name: file.name,
        path: path.resolve(APP_DIR, file.path),
      })),
      path.resolve(APP_DIR, outPath),
      (done, total) => event.sender.send('zip-progress', { done, total }),
    );
  }
  const finalPath = `${APP_DIR}/${outPath}`;
  const dir = path.dirname(finalPath);
  // 원자적 아카이브 쓰기: '.part' 임시 경로에 스트리밍 → 완료 시 rename.
  // 도중 강제 종료/앱 닫기 시 불완전 tar 가 최종 경로에 남지 않는다(임시 파일만
  // 잔존, 다음 부팅 정리 대상). 트랙1 (b) 마이그레이션 백업 원자성 스펙 §4-0.
  const tmpPath = `${finalPath}.part`;
  const files = inputFiles.map((x: any) => ({
    name: x.name,
    path: `${APP_DIR}/${x.path}`,
  }));
  await fs.mkdir(dir, { recursive: true });
  const pack = tarStream.pack();
  const writeStream = fsSync.createWriteStream(tmpPath);
  pack.pipe(writeStream);
  try {
    let done = 0;
    for (const file of files) {
      event.sender.send('zip-progress', {
        done,
        total: files.length,
      });
      await new Promise((resolve, reject) => {
        const srcPath = file.path;
        const destPath = file.name;
        const { size } = fsSync.statSync(srcPath);
        const stream = fsSync.createReadStream(srcPath);
        const entry = pack.entry({ name: destPath, size });
        stream.on('error', reject);
        entry.on('error', reject);
        entry.on('finish', resolve);
        stream.pipe(entry);
      });
      done += 1;
    }
    event.sender.send('zip-progress', {
      done: files.length,
      total: files.length,
    });
    // pack.finalize() 이후 writeStream 이 실제로 닫힐 때까지 기다린 뒤 rename 해야
    // 최종 파일이 온전하다.
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', () => resolve());
      writeStream.on('error', reject);
      pack.finalize();
    });
    await fs.rename(tmpPath, finalPath);
  } catch (e: any) {
    console.error('zip-files error:', e);
    pack.destroy();
    writeStream.destroy();
    // 불완전 임시 파일 정리 시도(실패는 무시)
    await fs.unlink(tmpPath).catch(() => {});
    throw new Error(`압축 중 오류: ${e.message || e}`);
  }

  return undefined;
});

// 데이터 루트 볼륨의 여유 공간(bytes) — 마이그레이션 백업 게이트 공간 판정용.
// statfs 미지원/오류 시 null(="알 수 없음")을 반환해 게이트가 경고 경로로 간다.
handleData('get-free-space', async () => {
  try {
    const st: any = await fs.statfs(APP_DIR);
    return st.bavail * st.bsize;
  } catch (e) {
    console.error('get-free-space error:', e);
    return null;
  }
});

handleData('unzip-files', async (_event, zipPath, outPath) => {
  try {
    const destination = `${APP_DIR}/${outPath}`;
    await fs.mkdir(destination, { recursive: true });
    const stream = fsSync
      .createReadStream(zipPath)
      .pipe(tar.extract(destination));
    await new Promise((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
  } catch (e: any) {
    console.error('unzip-files error:', e);
    throw new Error(`압축 해제 중 오류: ${e.message || e}`);
  }
});

ipcMain.handle('search-tags', async (_event, word, category) => {
  await tagDatabaseLoadPromise;
  return native.search(databases.tagDBId, word, category);
});

ipcMain.handle('load-pieces-db', async (_event, pieces) => {
  const csv = pieces
    .map((x: string) => {
      return `<${x}>,0,0,null`;
    })
    .join('\n');
  native.loadDB(databases.pieceDBId, csv);
});

ipcMain.handle('search-pieces', async (_event, word) => {
  return native.search(databases.pieceDBId, word);
});

handleData('list-files', async (_event, arg) => {
  return await listFilesInDirectory(`${APP_DIR}/${arg}`);
});

handleData('list-files-with-stats', async (_event, arg) => {
  const dir = `${APP_DIR}/${arg}`;
  try {
    const files = await fs.readdir(dir);
    const results = [];
    for (const name of files) {
      try {
        const stat = await fs.stat(path.join(dir, name));
        if (stat.isFile()) {
          results.push({ name, size: stat.size, mtime: stat.mtimeMs });
        }
      } catch (error) {
        // A concurrently removed file is a normal race. Permission and I/O
        // failures must reach the caller instead of producing a partial backup list.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return results;
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
});

handleData('read-file', async (_event, filename) => {
  const data = await fs.readFile(`${APP_DIR}/${filename}`, 'utf-8');
  return data;
});

handleData('write-file', async (_event, filename, data) => {
  const dir = path.dirname(`${APP_DIR}/${filename}`);
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = `${APP_DIR}/${uuidv4()}`;
  await fs.writeFile(tmpFile, data, 'utf-8');
  await fs.rename(tmpFile, `${APP_DIR}/${filename}`, { recursive: true });
});

// 전역(저장 경로와 무관) 파일 IO — 로그인 토큰처럼 데이터 저장소가 아니라
// "이 PC의 앱"에 귀속되는 파일용. config.json 과 같은 DEFAULT_APP_DIR(userData)
// 고정이라 saveLocation 을 바꿔도 함께 이동/유실되지 않는다.
ipcMain.handle('read-global-file', async (_event, filename) => {
  return await fs.readFile(`${DEFAULT_APP_DIR}/${filename}`, 'utf-8');
});

ipcMain.handle('write-global-file', async (_event, filename, data) => {
  await fs.mkdir(DEFAULT_APP_DIR, { recursive: true });
  const tmpFile = `${DEFAULT_APP_DIR}/${uuidv4()}`;
  await fs.writeFile(tmpFile, data, 'utf-8');
  await fs.rename(tmpFile, `${DEFAULT_APP_DIR}/${filename}`);
});

handleData('copy-file', async (_event, src, dest) => {
  const dir = path.dirname(`${APP_DIR}/${dest}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(`${APP_DIR}/${src}`, `${APP_DIR}/${dest}`);
});

// src(APP_DIR 상대) → 절대경로 dest 로 복사. 데스크톱 export 목표 폴더용.
handleData('copy-file-absolute', async (_event, src, absoluteDest) => {
  return await copyFileUnlessSame(path.resolve(APP_DIR, src), absoluteDest);
});

// ── 이미지 인코딩 단일 출처 (트랙2 WebP Phase 3) ──
// 원본(PNG 등) → webp/avif 인코딩. resize(선택)·품질·무손실·effort·EXIF 이월을
// 파라미터화한다. resize-image(내보내기·백업 최적화)와 convert-to-webp(생성 이미지
// 일괄 변환)가 각자 갖던 sharp 파이프라인을 여기로 통합한다.
// carryMetadata: NAI 프롬프트(원본 PNG tEXt 'Comment' JSON)를 EXIF ImageDescription
// 으로 이월 — 이전엔 convert-to-webp 만 보존하고 resize-image(내보내기)는 유실했다.
async function encodeImageFile(
  srcAbs: string,
  destAbs: string,
  opts: {
    format: 'webp' | 'avif';
    quality?: number;
    lossless?: boolean;
    effort?: number;
    resize?: { maxWidth: number; maxHeight: number };
    carryMetadata?: boolean;
    // NAI 알파 stealth 워터마크 보존(webp 전용). 소스에서 비트스트림을 추출해
    // 리사이즈된 출력 알파에 재삽입한다. 없으면/AVIF 면 일반 경로로 폴백.
    preserveStealth?: boolean;
  },
): Promise<void> {
  const buf = await fs.readFile(srcAbs);
  let comment: string | null = null;
  let sdstudioMetadata: SDStudioImageMetadataV1 | undefined;
  if (opts.carryMetadata) {
    try {
      const tags = ExifReader.load(buf);
      const c = tags.Comment;
      if (c) comment = (c.value ?? c.description ?? '').toString() || null;
    } catch {
      // 메타데이터 없음 — EXIF 없이 진행
    }
    sdstudioMetadata = extractSDStudioMetadataFromBase64(
      buf.toString('base64'),
    );
  }
  await fs.mkdir(path.dirname(destAbs), { recursive: true });

  const carrySDStudioMetadata = async () => {
    if (!sdstudioMetadata || opts.format !== 'webp') return;
    const webp = await fs.readFile(destAbs);
    const withMetadata = embedSDStudioMetadataInWebpBytes(
      webp,
      sdstudioMetadata,
    );
    await fs.writeFile(destAbs, withMetadata);
  };

  // ── NAI stealth 보존 경로 (webp 전용) ──
  // 소스 알파에서 stealth 비트스트림을 추출 → 리사이즈된 출력 알파에 재삽입 →
  // webp 무손실 알파로 인코딩. AVIF 는 알파를 평탄화하므로 대상이 아니다.
  if (opts.preserveStealth && opts.format === 'webp') {
    const src = await sharp(buf)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bits = extractStealthBits(
      src.data,
      src.info.width,
      src.info.height,
      src.info.channels,
    );
    if (bits) {
      let rp = sharp(buf);
      if (opts.resize) {
        rp = rp.resize(opts.resize.maxWidth, opts.resize.maxHeight, {
          fit: sharp.fit.inside,
          withoutEnlargement: true,
        });
      }
      const out = await rp
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (canEmbed(bits, out.info.width, out.info.height)) {
        embedStealthBits(
          out.data,
          out.info.width,
          out.info.height,
          out.info.channels,
          bits,
        );
        let enc = sharp(out.data, {
          raw: {
            width: out.info.width,
            height: out.info.height,
            channels: out.info.channels,
          },
        });
        // 무손실이면 알파도 무손실. 저손실이면 RGB 만 손실, 알파는 alphaQuality 100
        // 으로 무손실 유지(= stealth LSB 보존).
        enc = opts.lossless
          ? enc.webp({ lossless: true })
          : enc.webp({
              quality: opts.quality ?? 80,
              lossless: false,
              alphaQuality: 100,
            });
        if (comment) {
          enc = enc.withMetadata({
            exif: { IFD0: { ImageDescription: comment } },
          });
        }
        await enc.toFile(destAbs);
        await carrySDStudioMetadata();
        return;
      }
    }
    // stealth 없음/담기 부족 → 아래 일반 경로로 폴백(경고 없이 자연 통과)
  }

  let pipeline = sharp(buf);
  if (opts.resize) {
    pipeline = pipeline.resize(opts.resize.maxWidth, opts.resize.maxHeight, {
      fit: sharp.fit.inside,
      withoutEnlargement: true,
    });
  }
  if (opts.format === 'avif') {
    pipeline = pipeline.avif({
      quality: opts.quality ?? 50,
      effort: opts.effort ?? 4,
    });
  } else if (opts.lossless) {
    pipeline = pipeline.webp({ lossless: true });
  } else {
    pipeline = pipeline.webp({ quality: opts.quality ?? 80, lossless: false });
  }
  if (comment) {
    pipeline = pipeline.withMetadata({
      exif: { IFD0: { ImageDescription: comment } },
    });
  }
  await pipeline.toFile(destAbs);
  await carrySDStudioMetadata();
}

// 생성 이미지 PNG → WebP 변환 (NAI 프롬프트 메타데이터를 EXIF ImageDescription 으로 이월).
handleData('convert-to-webp', async (_event, srcRel, destRel, quality) => {
  await encodeImageFile(`${APP_DIR}/${srcRel}`, `${APP_DIR}/${destRel}`, {
    format: 'webp',
    quality: quality ?? 80,
    carryMetadata: true,
  });
});

handleData('read-data-file', async (_event, arg) => {
  return await readFileAsDataURL(`${APP_DIR}/${arg}`);
});

handleData('write-data-file', async (_event, filename, data) => {
  const binaryData = Buffer.from(data, 'base64');
  const dir = path.dirname(`${APP_DIR}/${filename}`);
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = `${APP_DIR}/${uuidv4()}`;
  await fs.writeFile(tmpFile, binaryData);
  await fs.rename(tmpFile, `${APP_DIR}/${filename}`, { recursive: true });
});

handleData('write-data-file-absolute', async (_event, absolutePath, data) => {
  const binaryData = Buffer.from(data, 'base64');
  const dir = path.dirname(absolutePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = path.join(dir, uuidv4());
  await fs.writeFile(tmpFile, binaryData);
  await fs.rename(tmpFile, absolutePath, { recursive: true });
});

handleData('exist-file-absolute', async (_event, absolutePath) => {
  try {
    await fs.access(absolutePath);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
});

const imageWatches = new ImageWatchService({
  root: () => APP_DIR,
  watchDirectory: (directory) =>
    chokidar.watch(directory, {
      persistent: true,
      ignoreInitial: true,
      usePolling: false,
    }),
  readTags: (file) => exiftool.read(file),
  writeTags: (file, tags) => exiftool.write(file, tags),
  fingerprint: async (file) => {
    const stat = await fs.stat(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  },
  changed: (relativePath) => broadcast('image-changed', relativePath),
  report: (error) => log.error('Image watcher:', error),
});
handleData('rename-file', async (_event, oldfile, newfile) => {
  const oldPath = path.join(APP_DIR, oldfile);
  const newPath = path.join(APP_DIR, newfile);
  await Promise.all([
    imageWatches.forgetPath(oldPath),
    imageWatches.forgetPath(newPath),
  ]);
  await fs.mkdir(path.dirname(newPath), { recursive: true });
  return await fs.rename(oldPath, newPath);
});

async function safeRemove(dirPath: string, retries = 10, delay = 100) {
  if (!(await fsExtra.pathExists(dirPath))) return;
  for (let i = 0; i < retries; i += 1) {
    try {
      await fsExtra.remove(dirPath);
      return;
    } catch (err: any) {
      if (err.code === 'ENOENT') return;
      if (i === retries - 1) throw err;
      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });
    }
  }
}

handleData('rename-dir', async (_event, oldfile, newfile) => {
  const platform = os.platform();
  const oldPath = `${APP_DIR}/${oldfile}`;
  const newPath = `${APP_DIR}/${newfile}`;

  if (!(await fsExtra.pathExists(oldPath))) {
    return;
  }

  await imageWatches.forgetDirectory(oldPath);

  if (platform === 'win32') {
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (e: any) {
        if (e.code === 'ENOENT') {
          return;
        }
        if (i === 9) {
          await fsExtra.copy(oldPath, newPath);
          await safeRemove(oldPath);
        } else {
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
        }
      }
    }
  } else {
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    try {
      await fs.rename(oldPath, newPath);
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
  }
});

handleData('delete-file', async (_event, filename) => {
  await imageWatches.forgetPath(filename);
  return await fs.unlink(`${APP_DIR}/${filename}`);
});

handleData('delete-dir', async (_event, filename) => {
  const dirPath = `${APP_DIR}/${filename}`;
  if (!(await fsExtra.pathExists(dirPath))) {
    return undefined;
  }
  await imageWatches.forgetDirectory(dirPath);

  if (os.platform() === 'win32') {
    return await safeRemove(dirPath);
  }
  try {
    return await fs.rmdir(dirPath, { recursive: true });
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }

  return undefined;
});

handleData('trash-file', async (_event, filename) => {
  await imageWatches.forgetPath(filename);
  await shell.trashItem(path.join(APP_DIR, filename));
});

ipcMain.handle('close', async (event) => {
  // 저장 완료 위임 — 호출한 창만 게이트를 열고 그 창만 다시 닫는다.
  const win = BrowserWindow.fromWebContents(event.sender);
  saveCompletedByWc.set(event.sender.id, true);
  win?.close();
});

// 앱 자체 재시작 — 종료 후 자동 재실행을 예약하고 정상 종료 경로(close)를 탄다.
// close 인터셉트(창별 saveCompleted 게이트)를 그대로 거치므로 렌더러의 종료 시
// 저장(flush)이 보장된다. 저장소 마이그레이션 재시작 버튼용. 앱 전체 재시작이라
// 모든 창을 닫는다(각 창이 자기 저장을 flush 한 뒤 닫힘 → 마지막 창에서 앱 종료·재실행).
ipcMain.handle('restart-app', async () => {
  app.relaunch();
  for (const w of BrowserWindow.getAllWindows()) w.close();
});

handleData('exist-file', async (_event, filename) => {
  try {
    await fs.access(`${APP_DIR}/${filename}`);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
});

handleData('download', async (event, url, dest, filename) => {
  const destination = path.join(APP_DIR, dest);
  await fs.mkdir(destination, { recursive: true });
  // 요청한 창(event.sender)을 다운로드 소유 창·진행 이벤트 수신 창으로 삼는다.
  const reqWin = BrowserWindow.fromWebContents(event.sender) ?? mainWindow!;
  const options = {
    directory: destination,
    saveAs: false,
    openFolderWhenDone: false,
    filename,
    onProgress: (progress: any) => {
      event.sender.send('download-progress', progress);
    },
  };
  try {
    await electronDL.download(reqWin, url, options);
  } catch (e) {
    if (!(e instanceof electronDL.CancelError)) {
      console.error(e);
    }
  }
});

// ===== 아티스트 태깅: 로컬 ONNX 추론 (WD tagger / Kaloscope) =====
// onnxruntime-node는 시작 비용을 피하려고 핸들러 안에서 지연 require 한다.
// 세션/CSV는 경로 기준으로 캐시 (모델 파일은 APP_DIR/models/).
const artistTagSessions: Map<string, any> = new Map();
const artistTagCsvCache: Map<string, any> = new Map();

handleData('artist-analyze', async (_event, arg) => {
  const { imageBase64, model } = arg as {
    imageBase64: string;
    model: 'kaloscope' | 'wd-swinv2' | 'wd-eva02';
  };
  const ort = require('onnxruntime-node');
  const modelsDir = path.join(APP_DIR, 'models');

  const getSession = async (file: string) => {
    const p = path.join(modelsDir, file);
    if (!fsSync.existsSync(p)) {
      throw new Error(`모델 파일이 없습니다: ${file}`);
    }
    if (!artistTagSessions.has(p)) {
      artistTagSessions.set(p, await ort.InferenceSession.create(p));
    }
    return artistTagSessions.get(p);
  };

  const imgBuf = Buffer.from(imageBase64, 'base64');
  const SIZE = 448;

  if (model === 'kaloscope') {
    // 전처리: timm 표준 평가 변환 재현 (HF 데모 Space와 동일 결과를 내기 위함) —
    // 모델 cfg crop_pct=0.9 → 짧은 변을 497(=floor(448/0.9))로 비율 유지 리사이즈(bicubic)
    // 후 448 중앙 크롭 → RGB /255 → ImageNet 정규화 → NCHW
    const SCALE = Math.floor(SIZE / 0.9); // 497
    const off = Math.floor((SCALE - SIZE) / 2);
    const { data } = await sharp(imgBuf)
      .removeAlpha()
      .resize(SCALE, SCALE, { fit: 'cover', kernel: 'cubic' })
      .extract({ left: off, top: off, width: SIZE, height: SIZE })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    const f = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        f[c * SIZE * SIZE + i] = (data[i * 3 + c] / 255 - mean[c]) / std[c];
      }
    }
    const session = await getSession('kaloscope_2-0.onnx');
    const out = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', f, [1, 3, SIZE, SIZE]),
    });
    const logits = out[session.outputNames[0]].data;

    // softmax → top-20
    let mx = -Infinity;
    for (const v of logits) if (v > mx) mx = v;
    let sum = 0;
    const exps = new Float64Array(logits.length);
    for (let i = 0; i < logits.length; i += 1) {
      exps[i] = Math.exp(logits[i] - mx);
      sum += exps[i];
    }

    // class_mapping.csv: class_id,class_name (이름이 작은따옴표로 감싸인 경우 있음)
    const csvPath = path.join(modelsDir, 'kaloscope_class_mapping.csv');
    let names = artistTagCsvCache.get(csvPath);
    if (!names) {
      names = {} as any;
      const lines = (await fs.readFile(csvPath, 'utf-8')).split('\n');
      for (let i = 1; i < lines.length; i += 1) {
        const l = lines[i].trim();
        if (!l) continue;
        const ci = l.indexOf(',');
        const id = parseInt(l.slice(0, ci), 10);
        let nm = l.slice(ci + 1);
        if (nm.startsWith("'") && nm.endsWith("'")) nm = nm.slice(1, -1);
        names[id] = nm;
      }
      artistTagCsvCache.set(csvPath, names);
    }
    const idx = Array.from({ length: logits.length }, (_: any, i: number) => i)
      .sort((a, b) => exps[b] - exps[a])
      .slice(0, 20);
    return {
      artists: idx.map((i) => ({
        tag: names[i] ?? String(i),
        score: exps[i] / sum,
      })),
    };
  }

  // WD tagger 전처리: 흰 배경 정사각 패딩 → 448 리사이즈(bicubic) → BGR → NHWC float32 0-255
  // (SmilingWolf wd-v3 표준 전처리)
  // 주의: sharp는 체인 호출 순서가 아니라 내부 고정 순서로 연산을 적용해
  // 한 파이프라인에서는 resize가 extend보다 먼저 실행된다 → 패딩과 리사이즈를
  // 반드시 두 단계로 분리해야 함 (합치면 비정사각 출력이 나와 결과가 망가짐)
  const meta = await sharp(imgBuf).metadata();
  const side = Math.max(meta.width!, meta.height!);
  const padded = await sharp(imgBuf)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .extend({
      top: Math.floor((side - meta.height!) / 2),
      bottom: Math.ceil((side - meta.height!) / 2),
      left: Math.floor((side - meta.width!) / 2),
      right: Math.ceil((side - meta.width!) / 2),
      background: { r: 255, g: 255, b: 255 },
    })
    .toBuffer();
  const { data, info } = await sharp(padded)
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== SIZE || info.height !== SIZE || info.channels !== 3) {
    throw new Error(
      `전처리 결과 크기 오류: ${info.width}x${info.height}x${info.channels}`,
    );
  }
  const f = new Float32Array(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i += 1) {
    f[i * 3 + 0] = data[i * 3 + 2]; // B
    f[i * 3 + 1] = data[i * 3 + 1]; // G
    f[i * 3 + 2] = data[i * 3 + 0]; // R
  }
  // WD 두 모델은 전처리·태그 CSV가 동일하고 onnx 파일만 다름
  const session = await getSession(
    model === 'wd-eva02' ? 'wd-eva02-large-v3.onnx' : 'wd-swinv2-v3.onnx',
  );
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', f, [1, SIZE, SIZE, 3]),
  });
  const probs = out[session.outputNames[0]].data;

  // selected_tags.csv: tag_id,name,category,count (category 9=rating, 0=general, 4=character)
  const csvPath = path.join(modelsDir, 'wd_selected_tags.csv');
  let tags = artistTagCsvCache.get(csvPath);
  if (!tags) {
    tags = [] as any[];
    const lines = (await fs.readFile(csvPath, 'utf-8')).split('\n');
    for (let i = 1; i < lines.length; i += 1) {
      const l = lines[i].trim();
      if (!l) continue;
      const parts = l.split(',');
      tags.push({ name: parts[1], category: parseInt(parts[2], 10) });
    }
    artistTagCsvCache.set(csvPath, tags);
  }
  const rating: any[] = [];
  const general: any[] = [];
  const character: any[] = [];
  for (let i = 0; i < tags.length; i += 1) {
    const p = probs[i];
    if (tags[i].category === 9) rating.push({ tag: tags[i].name, score: p });
    else if (tags[i].category === 0 && p >= 0.35)
      general.push({ tag: tags[i].name, score: p });
    else if (tags[i].category === 4 && p >= 0.85)
      character.push({ tag: tags[i].name, score: p });
  }
  rating.sort((a, b) => b.score - a.score);
  general.sort((a, b) => b.score - a.score);
  character.sort((a, b) => b.score - a.score);
  return { rating, general, character };
});

handleData(
  'resize-image',
  async (
    _event,
    {
      inputPath,
      outputPath,
      maxWidth,
      maxHeight,
      optimize,
      quality,
      preserveStealth,
    },
  ) => {
    try {
      const srcAbs = `${APP_DIR}/${inputPath}`;
      const destAbs = `${APP_DIR}/${outputPath}`;
      // optimize 미지정 = 순수 리사이즈(썸네일 생성 등). 포맷 변환·EXIF 이월 없이
      // 확장자대로 인코딩한다(기존 동작 불변).
      if (!optimize) {
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        // 경로 입력 금지 — sharp(경로)는 webp 소스를 mmap 으로 연 채 vips 캐시에
        // 유지해, Windows 에서 원본의 휴지통 이동(rename)·영구 삭제(unlink)가
        // EBUSY 로 실패한다(png 는 스트림 읽기라 무관). 버퍼로 읽어 핸들을 남기지
        // 않는다 (2026-07-26 휴지통 webp 미삭제 버그).
        await sharp(await fs.readFile(srcAbs))
          .resize(maxWidth, maxHeight, {
            fit: sharp.fit.inside,
            withoutEnlargement: true,
          })
          .toFile(destAbs);
        return;
      }
      // 최적화 = webp/avif 인코딩(+리사이즈). quality 미지정 시 종전 하드코딩값
      // (webp 80·avif 50)과 동일. NAI 프롬프트 메타데이터를 보존한다(유실 버그 수정).
      await encodeImageFile(srcAbs, destAbs, {
        format: optimize === ImageOptimizeMethod.AVIF ? 'avif' : 'webp',
        lossless: optimize === ImageOptimizeMethod.LOSSLESS,
        quality,
        resize: { maxWidth, maxHeight },
        carryMetadata: true,
        preserveStealth,
      });
    } catch (e: any) {
      console.error('resize-image error:', e);
      throw new Error(`이미지 리사이즈 실패: ${e.message || e}`);
    }
  },
);

ipcMain.handle('select-dir', async (event) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(
    BrowserWindow.fromWebContents(event.sender) ?? mainWindow!,
    {
      properties: ['openDirectory'],
    },
  );
  if (!canceled) return filePaths[0];

  return undefined;
});

ipcMain.handle('select-file', async (event, options?: any) => {
  // options(선택, 하위 호환 — 드라이브 동기화 ②): defaultPath = 선택기 시작 폴더,
  // filters = 확장자 필터. 형식이 맞지 않는 값은 무시하고 기존 동작으로 연다.
  const dialogOptions: Electron.OpenDialogOptions = {
    properties: ['openFile'],
  };
  if (typeof options?.defaultPath === 'string' && options.defaultPath.trim()) {
    dialogOptions.defaultPath = options.defaultPath;
  }
  if (
    Array.isArray(options?.filters) &&
    options.filters.every(
      (f: any) =>
        f &&
        typeof f.name === 'string' &&
        Array.isArray(f.extensions) &&
        f.extensions.every((x: any) => typeof x === 'string'),
    )
  ) {
    dialogOptions.filters = options.filters;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(
    BrowserWindow.fromWebContents(event.sender) ?? mainWindow!,
    dialogOptions,
  );
  if (!canceled) return filePaths[0];

  return undefined;
});

ipcMain.handle('select-files', async (event, options) => {
  const dialogOptions: any = {
    properties: ['openFile', 'multiSelections'],
  };
  if (options?.filters) {
    dialogOptions.filters = options.filters;
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(
    BrowserWindow.fromWebContents(event.sender) ?? mainWindow!,
    dialogOptions,
  );
  if (canceled) {
    return [];
  }
  return filePaths;
});

ipcMain.handle('read-binary-file', async (_event, filePath) => {
  const data = await fs.readFile(filePath);
  return data.toString('base64');
});

handleData('copy-image-to-clipboard', async (_event, imagePath) => {
  const image = nativeImage.createFromPath(`${APP_DIR}/${imagePath}`);
  await clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([Uint8Array.from(image.toPNG())], {
        type: 'image/png',
      }),
    }),
  ]);
});

const util = require('util');
const { exec } = require('child_process');

const execPromise = util.promisify(exec);

async function openImageEditor(inputPath: string) {
  const editor = config.imageEditor ?? 'photoshop';
  const homeDir = os.homedir();
  const gimpBaseDirCand1 = path.join(homeDir, 'AppData', 'Local', 'Programs');
  const gimpBaseDirCand2 = 'C:\\Program Files';
  async function findGimpPath(baseDir: string) {
    const platform = os.platform();

    if (platform === 'win32') {
      const gimpDir = 'GIMP 2';
      const binDir = 'bin';
      const gimpPath = path.join(baseDir, gimpDir, binDir);
      const files = await fs.readdir(gimpPath);
      const gimpExecutable = files.find(
        (file: string) => file.startsWith('gimp-') && file.endsWith('.exe'),
      );
      if (gimpExecutable) {
        return path.join(gimpPath, gimpExecutable);
      }
      throw new Error('GIMP executable not found.');
    } else if (platform === 'darwin') {
      return '/Applications/GIMP.app';
    } else if (platform === 'linux') {
      // 리눅스는 배포판마다 설치 경로가 달라 PATH 의 gimp 에 위임한다.
      return 'gimp';
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  const commonPaths = [
    'C:\\Program Files\\Adobe\\Adobe Photoshop CC 2019\\Photoshop.exe',
    'C:\\Program Files\\Adobe\\Adobe Photoshop CC 2020\\Photoshop.exe',
    'C:\\Program Files\\Adobe\\Adobe Photoshop CC 2021\\Photoshop.exe',
    'C:\\Program Files\\Adobe\\Adobe Photoshop 2022\\Photoshop.exe',
    'C:\\Program Files\\Adobe\\Adobe Photoshop 2023\\Photoshop.exe',
    'C:\\Program Files\\Adobe\\Adobe Photoshop 2024\\Photoshop.exe',
    'C:\\Program Files\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe',
    'C:\\Program Files\\Adobe\\Adobe Photoshop 2026\\Photoshop.exe',
    '/Applications/Adobe Photoshop CC 2019/Adobe Photoshop CC 2019.app',
    '/Applications/Adobe Photoshop CC 2020/Adobe Photoshop CC 2020.app',
    '/Applications/Adobe Photoshop CC 2021/Adobe Photoshop CC 2021.app',
    '/Applications/Adobe Photoshop 2022/Adobe Photoshop 2022.app',
    '/Applications/Adobe Photoshop 2023/Adobe Photoshop 2023.app',
    '/Applications/Adobe Photoshop 2024/Adobe Photoshop 2024.app',
    '/Applications/Adobe Photoshop 2025/Adobe Photoshop 2025.app',
    '/Applications/Adobe Photoshop 2026/Adobe Photoshop 2026.app',
  ];

  async function findPhotoshopPath(paths: string[]) {
    for (const photoshopPath of paths) {
      if (
        await fs
          .access(photoshopPath)
          .then(() => true)
          .catch(() => false)
      ) {
        return photoshopPath;
      }
    }
    return null;
  }

  const editorsToTry = ['photoshop', 'gimp', 'mspaint'];
  editorsToTry.splice(editorsToTry.indexOf(editor), 1);
  editorsToTry.unshift(editor);
  const runProgram = async (program: string) => {
    // mac 만 앱 번들을 open -a 로 열고, win/linux 는 실행 파일 직접 실행.
    const command =
      os.platform() === 'darwin'
        ? `open -a "${program}" "${path.resolve(inputPath)}"`
        : `"${program}" "${path.resolve(inputPath)}"`;

    exec(command, (err: any) => {
      if (err) {
        console.error(`Error opening Photoshop: ${err.message}`);
        return;
      }
      console.log('Image editor opened successfully.');
    });
  };
  for (const edi of editorsToTry) {
    switch (edi) {
      case 'photoshop':
        try {
          const photoshopPath = await findPhotoshopPath(commonPaths);
          if (photoshopPath) {
            runProgram(photoshopPath);
            return;
          }
        } catch {
          // This candidate is unavailable; try the next installed editor.
        }
        break;
      case 'gimp':
        try {
          const gimpPath = await findGimpPath(gimpBaseDirCand1);
          if (gimpPath) {
            runProgram(gimpPath);
            return;
          }
        } catch {
          // Probe the remaining install location/editor after an unavailable candidate.
        }
        try {
          const gimpPath = await findGimpPath(gimpBaseDirCand2);
          if (gimpPath) {
            runProgram(gimpPath);
            return;
          }
        } catch {
          // Probe the remaining install location/editor after an unavailable candidate.
        }
        break;
      case 'mspaint':
        if (os.platform() === 'win32') {
          runProgram('mspaint');
          return;
        }
        break;
      default:
        // An unknown saved preference still permits the known fallback editors.
        break;
    }
  }
}

handleData('open-image-editor', async (_event, inputPath) => {
  await openImageEditor(`${APP_DIR}/${inputPath}`);
});

handleData('watch-image', (event, inputPath: string) =>
  imageWatches.watch(event.sender.id, inputPath),
);

ipcMain.handle('unwatch-image', (event, inputPath: string) =>
  imageWatches.unwatch(event.sender.id, inputPath),
);

const localAI = new LocalAIService('http://127.0.0.1');

handleData('load-model', async (_event, modelPath) => {
  try {
    const absoluteModelPath = path.resolve(path.join(APP_DIR, modelPath));
    await localAI.loadModel(absoluteModelPath, config.useCUDA ?? false);
  } catch (e: any) {
    console.error('load-model error:', e);
    throw new Error(`모델 로드 실패: ${e.message || e}`);
  }
});

handleData('extract-zip', async (event, zipPath, outPath) => {
  try {
    const platform = os.platform();

    if (platform === 'win32') {
      const dir = path.join(APP_DIR, outPath);
      const zip = new AsyncStreamZip({ file: path.join(APP_DIR, zipPath) });
      try {
        let numExtracted = 0;
        const entries = Object.values(await zip.entries());
        zip.on('extract', (_entry: any, _file: any) => {
          numExtracted += 1;
          event.sender.send('download-progress', {
            percent: numExtracted / entries.length,
          });
        });
        await fs.mkdir(dir, { recursive: true });
        await zip.extract(null, dir);
      } finally {
        await zip.close();
      }
    } else {
      const command = `unzip -o "${APP_DIR}/${zipPath}" -d "${APP_DIR}/${outPath}"`;
      await execPromise(command);
    }
  } catch (e: any) {
    console.error('extract-zip error:', e);
    throw new Error(`ZIP 해제 실패: ${e.message || e}`);
  }
});

ipcMain.handle('lookup-tag', async (_event, word) => {
  await tagDatabaseLoadPromise;
  return tagMap.get(word);
});

let localAIRunning = false;
let localAIProcess: ReturnType<typeof spawn> | null = null;

function killLocalAI() {
  if (localAIProcess && localAIProcess.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', localAIProcess.pid.toString()], {
        windowsHide: true,
      });
    } else {
      localAIProcess.kill();
    }
    localAIProcess = null;
    localAIRunning = false;
  }
}

const net = require('net');

function checkPort(port: number) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false); // Port is in use
      } else {
        reject(err); // Other errors
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve(true); // Port is available
      });
    });

    server.listen(port);
  });
}

async function findAvailablePort(startPort: number) {
  let port = startPort;
  while (!(await checkPort(port))) {
    port += 1;
  }
  return port;
}

async function spawnLocalAI() {
  localAI.port = await findAvailablePort(5353);
  localAIProcess = spawn(
    path.join(APP_DIR, 'localai', 'localai'),
    ['--port', localAI.port.toString()],
    {
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  localAIRunning = true;
  localAIProcess.on('close', (_code) => {
    localAIRunning = false;
    localAIProcess = null;
  });
}

handleData('spawn-local-ai', async (_event) => {
  if (!localAIRunning) {
    await spawnLocalAI();
  }
});

ipcMain.handle('is-local-ai-running', async (_event) => {
  return localAIRunning;
});

const qualityMap: any = {
  low: 320,
  normal: 640,
  high: 1024,
  veryhigh: 1536,
  veryveryhigh: 2048,
};

handleData('remove-bg', async (_event, inputImageBase64, outputPath) => {
  try {
    const absoluteOutputPath = path.join(APP_DIR, outputPath);
    await localAI.runModel(
      inputImageBase64,
      qualityMap[config.removeBgQuality ?? 'normal'],
      absoluteOutputPath,
    );
  } catch (e: any) {
    console.error('remove-bg error:', e);
    throw new Error(`배경 제거 실패: ${e.message || e}`);
  }
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug')({ showDevTools: true });
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '../../assets');

app.commandLine.appendSwitch('remote-allow-origins', 'http://localhost:8315');

const getAssetPath = (...paths: string[]): string => {
  return path.join(RESOURCES_PATH, ...paths);
};

// ── 창 위치·크기 상태 저장 (이 PC 귀속) ──────────────────────────────────────
// config.json 과 별개 파일로 관리한다. 렌더러 setConfig 가 config 전체를 덮어써도
// 창 상태가 지워지지 않도록 하기 위함.
const WINDOW_STATE_FILE = path.join(DEFAULT_APP_DIR, 'window-state.json');

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

function loadWindowState(): WindowState | null {
  try {
    const s = JSON.parse(fsSync.readFileSync(WINDOW_STATE_FILE, 'utf-8'));
    if (typeof s.width === 'number' && typeof s.height === 'number') {
      return s as WindowState;
    }
  } catch {
    // Missing or invalid optional geometry falls back to the visible primary display.
  }
  return null;
}

// 저장된 창이 현재 연결된 디스플레이 중 하나에 최소한 걸쳐 있는지 확인
// (모니터 분리/해상도 변경 후 화면 밖으로 복원되는 것을 방지)
function isVisibleOnSomeDisplay(s: WindowState): boolean {
  if (typeof s.x !== 'number' || typeof s.y !== 'number') return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      s.x! < a.x + a.width &&
      s.x! + s.width > a.x &&
      s.y! < a.y + a.height &&
      s.y! + s.height > a.y
    );
  });
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    // 최대화 상태에선 getBounds 가 최대화 크기를 주므로, 복원 시 이전 크기로 돌아가도록
    // 최대화 이전의 일반 크기(getNormalBounds)를 저장한다.
    const b = mainWindow.getNormalBounds();
    const state: WindowState = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      isMaximized,
    };
    const tmp = path.join(DEFAULT_APP_DIR, uuidv4());
    fsSync.writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    fsSync.renameSync(tmp, WINDOW_STATE_FILE);
  } catch (e) {
    console.error('window state save failed', e);
  }
}

let saveWindowStateTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveWindowState(): void {
  if (saveWindowStateTimer) clearTimeout(saveWindowStateTimer);
  saveWindowStateTimer = setTimeout(saveWindowState, 400);
}

// 보조 창(secondary) 위치 계산 — 기준 창(포커스된 창 → 주 창 → 첫 창)에서
// +32,+32 캐스케이드하되, 화면(workArea) 밖으로 나가지 않게 클램프한다. 보조 창은
// 상태를 저장/복원하지 않는다(주 창만 window-state.json 관리, W6 P0 §8).
function computeCascadeBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const OFFSET = 32;
  const ref =
    BrowserWindow.getFocusedWindow() ??
    (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null) ??
    BrowserWindow.getAllWindows()[0] ??
    null;
  const display = ref
    ? screen.getDisplayMatching(ref.getBounds())
    : screen.getPrimaryDisplay();
  const wa = display.workArea;
  const base = ref
    ? ref.getBounds()
    : { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  const width = Math.min(base.width, wa.width);
  const height = Math.min(base.height, wa.height);
  let x = base.x + OFFSET;
  let y = base.y + OFFSET;
  // 우/하단으로 넘치면 workArea 안으로 되돌린다.
  if (x + width > wa.x + wa.width) x = wa.x;
  if (y + height > wa.y + wa.height) y = wa.y;
  return { x, y, width, height };
}

// 창 생성 — 재사용 가능(주 창·보조 창 공용). secondary=true 면 상태 저장/복원 없이
// 캐스케이드 위치로 열고, mainWindow 포인터에 담지 않는다(주 창은 유지).
// initialProject: "새 창에서 열기"로 전달된 프로젝트 — 새 창이 부팅 후 가져가 연다.
const createWindow = async (opts?: {
  secondary?: boolean;
  initialProject?: string;
}) => {
  const secondary = opts?.secondary === true;
  if (isDebug && !secondary) {
    await installExtensions();
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const savedState = secondary ? null : loadWindowState();
  const useSavedPos = savedState != null && isVisibleOnSomeDisplay(savedState);
  const cascade = secondary ? computeCascadeBounds() : null;

  const win = new BrowserWindow({
    show: false,
    width: cascade?.width ?? savedState?.width ?? width,
    height: cascade?.height ?? savedState?.height ?? height,
    ...(cascade
      ? { x: cascade.x, y: cascade.y }
      : useSavedPos
        ? { x: savedState!.x, y: savedState!.y }
        : {}),
    // 좁은 창 대응(W6 후속, 2026-07-18): 1024→768. 1920 화면에 두 창(960px)을
    // 나란히 놓는 멀티 윈도우 사용을 허용한다. 768 미만은 미지원 — Tailwind md(768)
    // 아래는 모바일 전용 분기(사이드 도크·창 컨트롤이 hidden md:*)라 PC 구조가 깨진다.
    minWidth: 768,
    minHeight: 728,
    frame: false,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      webviewTag: true,
      // 백그라운드 타이머 스로틀 해제 (W6 P3, 2026-07-17 실기 피드백): 생성 호스트
      // (주 창)가 배경에 있으면 Chromium 이 setTimeout 을 1초+로 늦춰 큐 처리와
      // 미러 브로드캐스트(300ms 스로틀)가 수 초씩 지연된다. 위임 구조에서는
      // 사용자가 보조 창에서 작업하는 동안 호스트가 항상 배경이므로 필수.
      backgroundThrottling: false,
      preload: resolvePreloadPath(__dirname, app.isPackaged),
    },
  });

  // 주 창만 전역 포인터에 담는다(상태 저장·포커스 기준).
  if (!secondary) {
    mainWindow = win;
    // 최초 실행(저장된 상태 없음)엔 최대화로 시작 — 과거엔 workArea 크기의 어중간한 창이었다.
    // 이전에 최대화 상태로 종료했다면 그대로 최대화 복원.
    if (!savedState || savedState.isMaximized) {
      win.maximize();
    }
    // 사용자가 창을 옮기거나 크기를 바꾸면(그리고 최대화 토글 시) 상태를 저장한다.
    // 주 창만 — 보조 창은 상태를 저장하지 않는다.
    win.on('resize', scheduleSaveWindowState);
    win.on('move', scheduleSaveWindowState);
    win.on('maximize', saveWindowState);
    win.on('unmaximize', saveWindowState);
  }

  contextMenu({
    window: win,
    // danbooru 태그는 일반 구글 검색이 무의미하므로 기본 "구글 검색" 항목을 끈다.
    showSearchWithGoogle: false,
    // 기본 메뉴 항목 한글화
    labels: {
      cut: '잘라내기',
      copy: '복사',
      paste: '붙여넣기',
      selectAll: '전체 선택',
      copyLink: '링크 주소 복사',
      copyImage: '이미지 복사',
      copyImageAddress: '이미지 주소 복사',
      saveImage: '이미지 저장',
      saveImageAs: '다른 이름으로 이미지 저장',
      inspect: '검사',
      learnSpelling: '맞춤법에 추가',
      lookUpSelection: '“{selection}” 찾아보기',
    },
    prepend: (_defaultActions, params, browserWindow) => {
      console.log(params.mediaType);
      console.log(params.altText);
      console.log(params.titleText);
      // 콜백의 browserWindow(우클릭한 창)를 BrowserWindow 로 좁혀 그 창에만 send 한다.
      // (contextMenu 를 창마다 등록하므로 이 창 === 우클릭한 창)
      const bw = browserWindow as BrowserWindow;
      // 텍스트 드래그 선택 시: danbooru 태그 검색 (앱 내 웹 검색 탭으로 전달)
      if (
        params.selectionText &&
        params.selectionText.trim() &&
        params.mediaType !== 'image'
      ) {
        return [
          {
            label: 'Danbooru로 검색',
            click: () => {
              // 우클릭한 그 창으로 전달(멀티 윈도우 안전) — 콜백의 browserWindow 사용.
              bw?.webContents.send('danbooru-search', params.selectionText);
            },
          },
        ];
      }
      const handleContextAlt = (altContext: any) => {
        if (altContext.type === 'image') {
          return [
            {
              label: '해당 이미지를 다른 씬으로 복사',
              click: () => {
                bw?.webContents.send('copy-image', altContext);
              },
            },
            {
              label: '해당 이미지를 복제',
              click: () => {
                bw?.webContents.send('duplicate-image', altContext);
              },
            },
          ];
        }
        return [
          {
            label: '해당 씬을 맨위로 이동',
            click: () => {
              bw?.webContents.send('move-scene-front', altContext);
            },
          },
          {
            label: '해당 씬을 맨뒤로 이동',
            click: () => {
              bw?.webContents.send('move-scene-back', altContext);
            },
          },
          {
            label: '해당 씬을 복제',
            click: () => {
              bw?.webContents.send('duplicate-scene', altContext);
            },
          },
        ];
      };
      if (params.mediaType === 'image' && params.altText) {
        try {
          const altContext = JSON.parse(params.altText);
          return handleContextAlt(altContext);
        } catch (e) {
          console.error(e);
        }
      }
      if (params.mediaType === 'none' && params.titleText) {
        try {
          const altContext = JSON.parse(params.titleText);
          return handleContextAlt(altContext);
        } catch (e) {
          console.error(e);
        }
      }
      return [];
    },
  });

  win.loadURL(resolveHtmlPath('index.html'));

  win.on('ready-to-show', () => {
    if (process.env.START_MINIMIZED) {
      win.minimize();
    } else {
      win.show();
    }
  });

  // webContents.id 는 생성 시점에 캡처해 둔다 — 'closed' 는 창이 파괴된 뒤 발화하므로
  // 핸들러 안에서 win.webContents 에 접근하면 "Object has been destroyed" 가 난다.
  const wcId = win.webContents.id;
  const rendererRecovery = attachRendererRecovery(win, {
    releaseWatches: () => imageWatches.releaseOwner(wcId),
    prompt: (options) => dialog.showMessageBox(win, options),
    report: (message, detail) => log.error(message, detail),
  });

  // "새 창에서 열기" 초기 프로젝트 예치 — 이 창의 렌더러가 부팅 후 take-initial-project 로 가져간다.
  if (opts?.initialProject) {
    pendingInitialProject.set(wcId, opts.initialProject);
  }

  // 생성 호스트 배정 (W6 P3): 현재 호스트가 없으면(=첫 창) 이 창이 호스트가 된다.
  // 이후 열리는 보조 창은 호스트가 되지 않는다. 새 창 생성 시 호스트의 보조 창 수 갱신.
  if (generationHostWcId == null) generationHostWcId = wcId;
  notifyPeerCount();

  win.on('close', (e) => {
    // 주 창만 닫히기 직전의 위치·크기·최대화 상태를 저장한다(다음 실행 복원용).
    if (!secondary) saveWindowState();
    // 저장이 끝나기 전이면 창 닫기를 막고 렌더러에 저장을 위임한다(창별 게이트).
    // 렌더러가 저장을 마치면 invoke('close')로 이 창의 게이트를 열고 다시 닫는다.
    if (rendererRecovery.canSave() && !saveCompletedByWc.get(wcId)) {
      e.preventDefault();
      win.webContents.send('close');
    }
  });

  win.on('closed', () => {
    void imageWatches
      .releaseOwner(wcId)
      .catch((error) => log.error('Release image watchers:', error));
    // 창별 종료 게이트 정리 (캡처한 wcId 사용 — 이 시점의 win 은 이미 파괴됨).
    saveCompletedByWc.delete(wcId);
    // 이 창이 보유하던 프로젝트 배타 락 자동 해제 (W6 P1).
    for (const [name, owner] of projectLocks) {
      if (owner === wcId) projectLocks.delete(name);
    }
    pendingInitialProject.delete(wcId);
    // 생성 호스트 승격 (W6 P3): 호스트가 닫히면 남은 창 중 가장 오래된 창을 새
    // 호스트로 승격한다(기존 호스트 큐 내용은 소멸 — 현재 앱 종료 의미론과 동일).
    // 'closed' 는 파괴 후 발화하므로 getAllWindows() 에 닫힌 창은 이미 없다.
    if (generationHostWcId === wcId) {
      const remaining = BrowserWindow.getAllWindows().filter(
        (w) => !w.isDestroyed(),
      );
      generationHostWcId =
        remaining.length > 0 ? remaining[0].webContents.id : null;
      if (generationHostWcId != null) {
        broadcastHostRole();
        notifyPeerCount();
      }
    } else {
      // 보조 창이 닫힘 — 호스트의 보조 창 수만 갱신.
      notifyPeerCount();
    }
    if (!secondary) mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(win);
  menuBuilder.buildMenu();
  win.setMenu(null);

  // Open urls in the user's browser
  win.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });
};

// 새 창 열기 IPC — 보조 창 규칙(캐스케이드, 상태 저장 없음)으로 생성한다(W6 P0 §10).
// projectName 이 오면 "새 창에서 열기" — 새 창이 부팅 후 그 프로젝트를 연다(W6 P1).
handleData('open-new-window', async (_event, projectName?: string) => {
  if (appUpdateController?.isInstalling)
    throw new Error('업데이트 설치가 끝난 뒤 새 창을 열어 주세요.');
  await createWindow({ secondary: true, initialProject: projectName });
});

const dataDir = isDebug
  ? path.join(webpackPaths.appPath, 'data')
  : path.join(__dirname, '../../data');

function tagDatabaseKindForModel(modelVersion?: ModelVersion): TagDatabaseKind {
  return isV5ModelVersion(modelVersion ?? ModelVersion.V4_5) ? 'v5' : 'legacy';
}

async function applyTagDatabase(kind: TagDatabaseKind): Promise<void> {
  const filename = kind === 'v5' ? 'db_v5.csv' : 'db.csv';
  const csv = await fs.readFile(path.join(dataDir, filename), 'utf-8');
  native.loadDB(databases.tagDBId, csv);

  const nextMap = new Map<string, any>();
  csv.split('\n').forEach((line: string) => {
    const comps = line.split(',');
    if (comps.length !== 4) return;
    nextMap.set(comps[0], {
      word: comps[0],
      normalized: comps[0],
      freq: parseInt(comps[2], 10),
      category: parseInt(comps[1], 10),
      redirect: comps[3],
      priority: 0,
    });
  });
  tagMap = nextMap;
  activeTagDatabase = kind;
}

function loadTagDatabase(modelVersion?: ModelVersion): Promise<void> {
  const kind = tagDatabaseKindForModel(modelVersion);
  const previous = tagDatabaseLoadPromise.catch(() => undefined);
  tagDatabaseLoadPromise = previous.then(async () => {
    if (activeTagDatabase === kind) return;
    await applyTagDatabase(kind);
  });
  return tagDatabaseLoadPromise;
}

async function init() {
  const configPath = path.join(DEFAULT_APP_DIR, 'config.json');
  try {
    await fs.mkdir(DEFAULT_APP_DIR, { recursive: true });
  } catch (e: any) {
    configLoadFailure = {
      path: configPath,
      code: String(e?.code || e?.message || e),
    };
    return;
  }
  const loadedConfig = await loadJsonConfig<Config>(configPath);
  if (loadedConfig.kind === 'loaded') {
    config = loadedConfig.value;
  } else if (loadedConfig.kind === 'failed') {
    configLoadFailure = { path: configPath, code: loadedConfig.code };
    return;
  }
  databases.tagDBId = native.createDB('danbooru');
  await loadTagDatabase(config.modelVersion);
  databases.pieceDBId = native.createDB('pieces');
  await initFolder();
}

async function initFolder() {
  if (config.saveLocation) {
    APP_DIR = config.saveLocation;
  }
  try {
    await fs.mkdir(APP_DIR, { recursive: true });
    // mkdir 성공이 곧 쓰기 가능을 뜻하진 않는다(읽기전용 볼륨·ACL 제한). 실제 파일
    // 쓰기까지 확인해야 권한 없는 경로를 정확히 걸러낸다.
    const probe = path.join(APP_DIR, `.${uuidv4()}.wtest`);
    await fs.writeFile(probe, 'ok', 'utf-8');
    await fs.rm(probe).catch(() => {});
  } catch (e: any) {
    // Keep the attempted root and open only the recovery UI. No fallback,
    // cleanup, watchers, store initialization or automatic writes may start.
    saveLocationFallback = {
      attempted: APP_DIR,
      code: String(e?.code || e?.message || e),
    };
    return;
  }
  // 폴백까지 반영한 최종 데이터 루트로 판정한다(경고만, 경로·데이터 무변경).
  if (INSTALL_DIR && isSameOrInside(APP_DIR, INSTALL_DIR)) {
    saveLocationInsideInstall = { path: APP_DIR, installDir: INSTALL_DIR };
  }
  // 원자 쓰기(tmp+rename)가 쓰기와 rename 사이 강제 종료로 남긴 고아 tmp 파일 정리.
  // tmp 는 항상 uuid v4 파일명(확장자 없음)이라 정확히 그 형태만 지운다.
  const uuidName =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const dir of [APP_DIR]) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isFile() && uuidName.test(ent.name)) {
          await fs.rm(path.join(dir, ent.name)).catch(() => {});
        }
      }
    } catch (error) {
      // Temporary-file cleanup is best effort; retain inaccessible files and diagnose it.
      log.warn('Could not inspect temporary files:', dir, error);
    }
  }
  if (config.refreshImage) {
    // 생성 결과와 임포트한 JPEG 원본만 썸네일 무효화 대상이다.
    const originalImageExtensions = new Set([
      ...OUTPUT_IMAGE_EXTS.map((extension) => `.${extension}`),
      '.jpg',
      '.jpeg',
    ]);
    const handle = chokidar.watch(APP_DIR, {
      persistent: true,
      ignoreInitial: true,
      usePolling: false,
    });
    handle.on('change', async (changedPath: string) => {
      const curPath = path.relative(APP_DIR, changedPath);
      const comps = curPath.split(path.sep);
      if (comps.length === 0) return;
      if (comps[0] === '.') {
        comps.shift();
      }
      // 자체 썸네일 변경의 불필요한 브로드캐스트를 막는다. 프로젝트 JSON 등은
      // 원본이 아니므로 썸네일 삭제 IPC와 ENOENT 경고도 만들지 않는다.
      if (
        comps.includes('fastcache') ||
        !originalImageExtensions.has(path.extname(curPath).toLowerCase())
      ) {
        return;
      }
      if (
        comps[0] === 'outs' ||
        comps[0] === 'inpaints' ||
        comps[0] === 'workspace'
      ) {
        // 저장 경로 전역 감시 — 어느 창이 볼지 알 수 없으니 전 창 브로드캐스트.
        broadcast('image-changed', comps.join('/'));
      }
    });
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  // Only the owning process may initialize or clean the shared data directory.
  const initPromise = init();
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    // 살아있는 아무 창(주 창 우선)을 복원·포커스한다(멀티 윈도우).
    focusAnyWindow();
  });
  /**
   * Add event listeners...
   */

  app.on('before-quit', () => {
    killLocalAI();
  });

  app.on('window-all-closed', () => {
    // Respect the OSX convention of having the application in memory even
    // after all windows have been closed
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app
    .whenReady()
    .then(async () => {
      await initPromise;
      appUpdateController = registerAppUpdate({
        getDataRoot: () => {
          const failure = dataStorageError();
          if (failure) throw new Error(failure);
          return APP_DIR;
        },
        assertCanInstall: () => {
          const failure = dataStorageError();
          if (failure) throw new Error(failure);
          if (driveUploads.size || driveDownloads.size)
            throw new Error('드라이브 파일 전송이 끝난 뒤 업데이트해 주세요.');
        },
        helperPath: getAssetPath('update-helper.ps1'),
        reopenWindow: () => {
          void createWindow();
        },
      });
      createWindow();
      app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        // 창이 하나도 없으면 새 주 창을 만든다.
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
        // APP_DIR = app.getPath('userData');
      });
    })
    .catch(console.log);
}
