/* eslint jest/expect-expect: ["error", { "assertFunctionNames": ["assert", "assert.*"] }] */
/** @jest-environment node */
import assert from 'node:assert/strict';
import { registerAppUpdate } from '../registerAppUpdate';
import { DesktopReleaseUpdater } from '../desktopReleaseUpdater';
import {
  prepareWindowsUpdate,
  type PreparedWindowsUpdate,
} from '../updateInstaller';

jest.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: jest.fn(),
    getPath: jest.fn(),
    on: jest.fn(),
    quit: jest.fn(),
  },
  BrowserWindow: { getAllWindows: jest.fn() },
  ipcMain: { handle: jest.fn() },
  safeStorage: {
    isEncryptionAvailable: jest.fn(),
    encryptString: jest.fn(),
    decryptString: jest.fn(),
    getSelectedStorageBackend: jest.fn(),
  },
}));
jest.mock('../desktopReleaseUpdater', () => ({
  DesktopReleaseUpdater: jest.fn(),
}));
jest.mock('../updateInstaller', () => ({ prepareWindowsUpdate: jest.fn() }));
jest.mock('../../shared/appIdentity', () => ({
  APP_ID: 'io.fixture.private',
  APP_UPDATE_CHANNEL: 'private',
  APP_RELEASE_CHANNEL: { owner: 'fixture', repo: 'private-app', private: true },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

type WindowFixture = ReturnType<typeof windowFixture>;
function windowFixture(loading = false) {
  return {
    isDestroyed: jest.fn(() => false),
    close: jest.fn(),
    webContents: {
      send: jest.fn(),
      isLoading: jest.fn(() => loading),
      once: jest.fn(),
    },
  };
}

function helperFixture() {
  const acknowledgement = deferred<void>();
  const helper = {
    apply: jest.fn(() => acknowledgement.promise),
    cancel: jest.fn(),
    resultPath: '/fixture/update-result.json',
  };
  return { helper, acknowledgement };
}

const electron = jest.requireMock('electron') as {
  app: {
    isPackaged: boolean;
    getVersion: jest.Mock;
    getPath: jest.Mock;
    on: jest.Mock;
    quit: jest.Mock;
  };
  BrowserWindow: { getAllWindows: jest.Mock };
  ipcMain: { handle: jest.Mock };
};
const prepare = prepareWindowsUpdate as jest.MockedFunction<
  typeof prepareWindowsUpdate
>;
const Updater = DesktopReleaseUpdater as jest.MockedClass<
  typeof DesktopReleaseUpdater
>;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalPortable = process.env.PORTABLE_EXECUTABLE_FILE;

describe('desktop update save/quit handshake', () => {
  let windows: WindowFixture[];
  let mainWindow: WindowFixture;
  let preparation: Deferred<PreparedWindowsUpdate>;
  let ready: ReturnType<typeof helperFixture>;
  let listeners: Map<string, (event: { preventDefault(): void }) => void>;
  let quitEvents: Array<{ preventDefault: jest.Mock }>;
  let handler: (
    _event: unknown,
    operation: string,
    value?: string,
  ) => Promise<unknown>;
  let assertCanInstall: jest.Mock;
  let reopenWindow: jest.Mock;
  let controller: ReturnType<typeof registerAppUpdate>;

  function request(operation: string, value?: string) {
    return handler({}, operation, value);
  }

  function willQuit() {
    const event = { preventDefault: jest.fn() };
    const listener = listeners.get('will-quit');
    assert(listener, 'the lifecycle must register its quit barrier');
    listener(event);
    return event;
  }

  async function makeReady() {
    const installing = request('install');
    preparation.resolve(ready.helper);
    await installing;
  }

  beforeEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(process, 'platform', {
      ...originalPlatform,
      value: 'win32',
    });
    delete process.env.PORTABLE_EXECUTABLE_FILE;
    mainWindow = windowFixture();
    windows = [mainWindow];
    preparation = deferred<PreparedWindowsUpdate>();
    ready = helperFixture();
    listeners = new Map();
    quitEvents = [];
    assertCanInstall = jest.fn();
    reopenWindow = jest.fn(() => {
      windows = [windowFixture()];
    });
    electron.app.isPackaged = true;
    electron.app.getVersion.mockReturnValue('6.0.0-cupcake.6');
    electron.app.getPath.mockReturnValue('/fixture/profile');
    electron.app.on.mockImplementation((name, listener) => {
      listeners.set(name, listener);
      return electron.app;
    });
    electron.app.quit.mockImplementation(() => {
      quitEvents.push(willQuit());
    });
    electron.BrowserWindow.getAllWindows.mockImplementation(() => windows);
    electron.ipcMain.handle.mockImplementation((channel, callback) => {
      assert.equal(channel, 'app-update');
      handler = callback;
    });
    const updater = {
      isDownloading: false,
      getDownloaded: jest.fn(() => ({
        artifactPath: '/fixture/data/.updates/private/download/Studio.zip',
        dataRoot: '/fixture/data',
        release: { asset: { sha256: 'a'.repeat(64), size: 2048 } },
      })),
    };
    Updater.mockImplementation(
      () => updater as unknown as DesktopReleaseUpdater,
    );
    prepare.mockReturnValue(preparation.promise);
    controller = registerAppUpdate({
      getDataRoot: () => '/fixture/data',
      assertCanInstall,
      helperPath: '/fixture/resources/update-helper.ps1',
      reopenWindow,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
    if (originalPortable === undefined)
      delete process.env.PORTABLE_EXECUTABLE_FILE;
    else process.env.PORTABLE_EXECUTABLE_FILE = originalPortable;
  });

  test('closes through the normal save path and prevents every quit until helper ACK', async () => {
    const installing = request('install');
    assert.equal(controller.isInstalling, true);
    assert.equal(mainWindow.close.mock.calls.length, 0);
    assert.equal(ready.helper.apply.mock.calls.length, 0);
    await assert.rejects(request('install'), /준비/);
    assert.equal(prepare.mock.calls.length, 1);

    preparation.resolve(ready.helper);
    await installing;
    assert.equal(mainWindow.close.mock.calls.length, 1);
    assert.equal(ready.helper.apply.mock.calls.length, 0);
    assert.equal(electron.app.quit.mock.calls.length, 0);

    // The renderer has now saved its work and allowed its ordinary close.
    windows = [];
    const first = willQuit();
    const repeated = willQuit();
    assert.equal(first.preventDefault.mock.calls.length, 1);
    assert.equal(repeated.preventDefault.mock.calls.length, 1);
    assert.equal(ready.helper.apply.mock.calls.length, 1);
    assert.equal(electron.app.quit.mock.calls.length, 0);

    ready.acknowledgement.resolve();
    await ready.acknowledgement.promise;
    assert.equal(electron.app.quit.mock.calls.length, 1);
    assert.equal(quitEvents.length, 1);
    assert.equal(quitEvents[0].preventDefault.mock.calls.length, 0);
    assert.equal(reopenWindow.mock.calls.length, 0);
  });

  test('a preparation failure leaves the current window open and clears installation state', async () => {
    const installing = request('install');
    const failed = assert.rejects(installing, /fixture readiness failure/);
    preparation.reject(new Error('fixture readiness failure'));
    await failed;
    assert.equal(controller.isInstalling, false);
    assert.equal(windows[0], mainWindow);
    assert.equal(mainWindow.close.mock.calls.length, 0);
    assert.equal(ready.helper.apply.mock.calls.length, 0);
    assert.equal(electron.app.quit.mock.calls.length, 0);
    assert.equal(reopenWindow.mock.calls.length, 0);
  });

  test('cancelling while preparation is pending discards a late READY without closing the app', async () => {
    const installing = request('install');
    const cancelled = assert.rejects(installing, /취소/);
    await request('cancel-install');
    assert.equal(controller.isInstalling, false);
    assert.equal(mainWindow.close.mock.calls.length, 0);

    preparation.resolve(ready.helper);
    await cancelled;
    assert.equal(ready.helper.cancel.mock.calls.length, 1);
    assert.equal(ready.helper.apply.mock.calls.length, 0);
    assert.equal(mainWindow.close.mock.calls.length, 0);
    assert.equal(electron.app.quit.mock.calls.length, 0);
    assert.equal(windows[0], mainWindow);
  });

  test('a cancelled renderer save cancels the prepared helper and leaves the app running', async () => {
    await makeReady();
    // close() was requested, but the renderer has not acknowledged its save.
    assert.equal(mainWindow.close.mock.calls.length, 1);
    await request('cancel-install');
    assert.equal(controller.isInstalling, false);
    assert.equal(ready.helper.cancel.mock.calls.length, 1);
    assert.equal(ready.helper.apply.mock.calls.length, 0);
    assert.equal(electron.app.quit.mock.calls.length, 0);
    assert.equal(windows[0], mainWindow);
  });

  test('an ACK failure keeps the process alive and reports the error after the reopened window loads', async () => {
    const reopened = windowFixture(true);
    const noticeScheduled = deferred<void>();
    let deliverNotice: (() => void) | undefined;
    reopened.webContents.once.mockImplementation(
      (event: string, listener: () => void) => {
        assert.equal(event, 'did-finish-load');
        deliverNotice = listener;
        noticeScheduled.resolve();
      },
    );
    reopenWindow.mockImplementation(() => {
      windows = [reopened];
    });
    await makeReady();
    windows = [];
    const quitting = willQuit();
    ready.acknowledgement.reject(new Error('fixture ACK failure'));
    await noticeScheduled.promise;

    assert.equal(quitting.preventDefault.mock.calls.length, 1);
    assert.equal(electron.app.quit.mock.calls.length, 0);
    assert.equal(controller.isInstalling, false);
    assert.equal(reopenWindow.mock.calls.length, 1);
    assert.equal(ready.helper.cancel.mock.calls.length, 1);
    assert.equal(reopened.webContents.send.mock.calls.length, 0);
    assert(deliverNotice);
    deliverNotice();
    assert.equal(reopened.webContents.send.mock.calls.length, 1);
    assert.equal(
      reopened.webContents.send.mock.calls[0][0],
      'app-update-install-error',
    );
    assert.equal(
      reopened.webContents.send.mock.calls[0][1],
      'fixture ACK failure',
    );
  });

  test('cancellation after APPLY is rejected without discarding the helper or sending APPLY again', async () => {
    await makeReady();
    windows = [];
    assert.equal(willQuit().preventDefault.mock.calls.length, 1);
    assert.equal(ready.helper.apply.mock.calls.length, 1);

    await assert.rejects(request('cancel-install'), /취소/);
    assert.equal(controller.isInstalling, true);
    assert.equal(ready.helper.cancel.mock.calls.length, 0);
    assert.equal(reopenWindow.mock.calls.length, 0);
    assert.equal(electron.app.quit.mock.calls.length, 0);
    assert.equal(willQuit().preventDefault.mock.calls.length, 1);
    assert.equal(ready.helper.apply.mock.calls.length, 1);

    ready.acknowledgement.resolve();
    await ready.acknowledgement.promise;
    assert.equal(electron.app.quit.mock.calls.length, 1);
    assert.equal(quitEvents[0].preventDefault.mock.calls.length, 0);
  });

  test('one native failure reported by both onError and APPLY rejection produces one error notice', async () => {
    const reopened = windowFixture();
    reopenWindow.mockImplementation(() => {
      windows = [reopened];
    });
    await makeReady();
    windows = [];
    assert.equal(willQuit().preventDefault.mock.calls.length, 1);
    const nativeError = prepare.mock.calls[0][0].onError;
    assert(nativeError);
    const error = new Error('fixture native pipe failure');
    const rejected = assert.rejects(
      ready.acknowledgement.promise,
      /fixture native pipe failure/,
    );

    // The native helper adapter rejects APPLY and calls onError in one turn.
    ready.acknowledgement.reject(error);
    nativeError(error);
    await rejected;

    assert.equal(controller.isInstalling, false);
    assert.equal(electron.app.quit.mock.calls.length, 0);
    assert.equal(reopenWindow.mock.calls.length, 1);
    assert.equal(ready.helper.cancel.mock.calls.length, 1);
    assert.equal(reopened.webContents.send.mock.calls.length, 1);
    assert.equal(
      reopened.webContents.send.mock.calls[0][0],
      'app-update-install-error',
    );
    assert.equal(reopened.webContents.send.mock.calls[0][1], error.message);
  });

  test('another open window blocks installation before launching the helper', async () => {
    const otherWindow = windowFixture();
    windows.push(otherWindow);
    await assert.rejects(request('install'), /다른 SDStudio 창/);
    assert.equal(controller.isInstalling, false);
    assert.equal(prepare.mock.calls.length, 0);
    assert.equal(mainWindow.close.mock.calls.length, 0);
    assert.equal(otherWindow.close.mock.calls.length, 0);
    assert.equal(electron.app.quit.mock.calls.length, 0);
  });

  test('a window opened during preparation cancels the helper before either window closes', async () => {
    const installing = request('install');
    const rejected = assert.rejects(installing, /다른 SDStudio 창/);
    const otherWindow = windowFixture();
    windows.push(otherWindow);
    preparation.resolve(ready.helper);
    await rejected;
    assert.equal(controller.isInstalling, false);
    assert.equal(ready.helper.cancel.mock.calls.length, 1);
    assert.equal(ready.helper.apply.mock.calls.length, 0);
    assert.equal(mainWindow.close.mock.calls.length, 0);
    assert.equal(otherWindow.close.mock.calls.length, 0);
    assert.equal(electron.app.quit.mock.calls.length, 0);
  });

  test('late completion of a cancelled preparation cannot cancel a newer prepared install', async () => {
    const firstInstalling = request('install');
    const firstCancelled = assert.rejects(firstInstalling, /취소/);
    await request('cancel-install');

    const secondReady = helperFixture();
    prepare.mockResolvedValueOnce(secondReady.helper);
    await request('install');
    assert.equal(controller.isInstalling, true);
    assert.equal(mainWindow.close.mock.calls.length, 1);

    preparation.resolve(ready.helper);
    await firstCancelled;
    assert.equal(ready.helper.cancel.mock.calls.length, 1);
    assert.equal(secondReady.helper.cancel.mock.calls.length, 0);
    assert.equal(controller.isInstalling, true);

    windows = [];
    assert.equal(willQuit().preventDefault.mock.calls.length, 1);
    assert.equal(secondReady.helper.apply.mock.calls.length, 1);
    secondReady.acknowledgement.resolve();
    await secondReady.acknowledgement.promise;
    assert.equal(electron.app.quit.mock.calls.length, 1);
  });

  test('an obsolete helper error cannot fail a newer installation', async () => {
    const firstInstalling = request('install');
    const firstFailed = assert.rejects(
      firstInstalling,
      /obsolete helper failure/,
    );
    const obsoleteError = prepare.mock.calls[0][0].onError;
    assert(obsoleteError);
    await request('cancel-install');

    const secondReady = helperFixture();
    prepare.mockResolvedValueOnce(secondReady.helper);
    await request('install');
    const messagesBefore = mainWindow.webContents.send.mock.calls.length;
    const error = new Error('obsolete helper failure');
    obsoleteError(error);
    preparation.reject(error);
    await firstFailed;

    assert.equal(secondReady.helper.cancel.mock.calls.length, 0);
    assert.equal(controller.isInstalling, true);
    assert.equal(mainWindow.webContents.send.mock.calls.length, messagesBefore);
    assert.equal(electron.app.quit.mock.calls.length, 0);
  });
});
