/** @jest-environment jsdom */
import {
  deferred,
  flushMicrotasks,
} from '../testSupport/completionMethodHarness';

function createBindings() {
  const done = () => jest.fn<Promise<void>, []>(async () => undefined);
  const store = () => ({ load: done(), flushSave: done() });
  const backend = {
    getBootWarnings: jest.fn<Promise<unknown>, []>(async () => null),
    getConfig: jest.fn(async () => ({})),
    onLockOwnerNotice: jest.fn(),
    onGlobalStoreChanged: jest.fn(),
    onSessionOp: jest.fn(),
    onClose: jest.fn(),
    close: done(),
    takeInitialProject: jest.fn(async () => null),
  };
  const appState = {
    bootReady: false,
    storageBootFailure: null as string | null,
    configLoadFailure: null as { path: string; code: string } | null,
    saveLocationFallback: null,
    saveLocationInsideInstall: null,
    initExportPresets: done(),
    pushMessage: jest.fn(),
  };
  const services = {
    backend,
    sessionService: { init: done(), runLoop: done(), flushOnClose: done() },
    trashService: {},
    globalPieceService: store(),
    globalPresetService: store(),
    globalCharacterPresetService: store(),
    artistLibraryService: store(),
    projectTemplateService: { loaded: false, flushSave: done() },
    taskQueueService: {
      initGenerationHostBridge: done(),
      isGenerationHost: true,
      loadLogs: done(),
      flushSaveLogs: done(),
    },
    imageDownloadService: { loadSettings: done() },
    loginService: { loadTokenProfiles: done(), initializeLogin: done() },
    appUpdateNoticeService: { run: done() },
    localAIService: { statsModels: done() },
    backgroundNotificationService: { start: done() },
    backgroundKeepAliveService: { start: done() },
    templateService: {
      ensureLoaded: done(),
      migrateSceneTemplatesToHidden: done(),
    },
    imageHistoryService: { ensureLoaded: done() },
  };
  return {
    backend,
    appState,
    services,
    waitForStorageAccess: done(),
    persistService: { flushAll: done() },
    migrationService: {
      detect: jest.fn(async () => 'fresh'),
      markFreshAndActivate: done(),
    },
    applyMobileV2Default: done(),
    runMobilePermissionOnboarding: done(),
  };
}

let mockBindings: ReturnType<typeof createBindings>;
jest.mock('..', () => mockBindings.services);
jest.mock('mobx', () => ({ reaction: jest.fn() }));
jest.mock('../AppService', () => ({ appState: mockBindings.appState }));
jest.mock('../PersistenceService', () => ({
  persistService: mockBindings.persistService,
}));
jest.mock('../storagePermissionGate', () => ({
  waitForStorageAccess: mockBindings.waitForStorageAccess,
}));
jest.mock('../MigrationService', () => ({
  migrationService: mockBindings.migrationService,
}));
jest.mock('../mobileV2Default', () => ({
  applyMobileV2Default: mockBindings.applyMobileV2Default,
}));
jest.mock('../mobilePermissions', () => ({
  runMobilePermissionOnboarding: mockBindings.runMobilePermissionOnboarding,
}));
jest.mock('../storageLayout', () => ({ setWorkspaceLayoutActive: jest.fn() }));
jest.mock('../projectPaths', () => ({ WORKSPACE_ROOT: 'workspace' }));

function bootFixture() {
  mockBindings = createBindings();
  let boot!: () => Promise<void>;
  // A new renderer after restart has a new module-level started flag.
  jest.isolateModules(() => {
    boot = jest.requireActual('../bootstrap').bootstrapApp;
  });
  return { ...mockBindings, boot };
}

test('unreadable Android settings stop boot before user-data initialization or close writes', async () => {
  const f = bootFixture();
  f.waitForStorageAccess.mockRejectedValueOnce(
    new Error('saved config read denied'),
  );
  const report = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  try {
    await f.boot();
    expect(f.appState.storageBootFailure).toContain('saved config read denied');
    expect(f.appState.bootReady).toBe(false);
    expect(f.backend.getConfig).not.toHaveBeenCalled();
    expect(f.backend.onClose).not.toHaveBeenCalled();
    expect(f.migrationService.detect).not.toHaveBeenCalled();
    expect(f.services.sessionService.init).not.toHaveBeenCalled();
    expect(f.services.globalPresetService.load).not.toHaveBeenCalled();
    expect(f.services.sessionService.runLoop).not.toHaveBeenCalled();
    expect(f.services.loginService.loadTokenProfiles).not.toHaveBeenCalled();
    expect(f.runMobilePermissionOnboarding).not.toHaveBeenCalled();
  } finally {
    report.mockRestore();
  }
});

test('a pending permission gate starts no saves, and a permitted first run completes normally', async () => {
  const f = bootFixture();
  const permission = deferred<void>();
  f.waitForStorageAccess.mockReturnValueOnce(permission.promise);
  const booting = f.boot();
  await flushMicrotasks();
  expect(f.appState.bootReady).toBe(false);
  expect(f.backend.onClose).not.toHaveBeenCalled();
  expect(f.services.sessionService.init).not.toHaveBeenCalled();
  permission.resolve();
  await booting;
  expect(f.appState.storageBootFailure).toBeNull();
  expect(f.appState.bootReady).toBe(true);
  expect(f.backend.onClose).toHaveBeenCalledTimes(1);
  expect(f.migrationService.markFreshAndActivate).toHaveBeenCalledTimes(1);
  expect(f.services.sessionService.init).toHaveBeenCalledTimes(1);
  expect(f.services.sessionService.runLoop).toHaveBeenCalledTimes(1);
});

test('unavailable desktop selected root stops all data initialization and background saving', async () => {
  const f = bootFixture();
  const failure = { attempted: 'D:/chosen-data', code: 'EACCES' };
  f.backend.getBootWarnings.mockResolvedValueOnce({
    saveLocationFallback: failure,
  });
  await f.boot();
  expect(f.appState.saveLocationFallback).toEqual(failure);
  expect(f.appState.bootReady).toBe(false);
  expect(f.waitForStorageAccess).not.toHaveBeenCalled();
  expect(f.services.sessionService.init).not.toHaveBeenCalled();
  expect(f.services.globalPresetService.load).not.toHaveBeenCalled();
  expect(f.services.sessionService.runLoop).not.toHaveBeenCalled();
  expect(f.services.loginService.loadTokenProfiles).not.toHaveBeenCalled();
  expect(f.backend.onClose).toHaveBeenCalledTimes(1);
  f.backend.onClose.mock.calls[0][0]();
  await flushMicrotasks();
  expect(f.backend.close).toHaveBeenCalledTimes(1);
  expect(f.services.sessionService.flushOnClose).not.toHaveBeenCalled();
  expect(f.persistService.flushAll).not.toHaveBeenCalled();
});

test('desktop config warnings retain their existing close-without-saving path', async () => {
  const f = bootFixture();
  const failure = { path: '/private/config.json', code: 'EACCES' };
  f.backend.getBootWarnings.mockResolvedValueOnce({
    configLoadFailure: failure,
  });
  await f.boot();
  expect(f.appState.configLoadFailure).toEqual(failure);
  expect(f.appState.bootReady).toBe(false);
  expect(f.waitForStorageAccess).not.toHaveBeenCalled();
  expect(f.services.sessionService.init).not.toHaveBeenCalled();
  expect(f.backend.onClose).toHaveBeenCalledTimes(1);
  f.backend.onClose.mock.calls[0][0]();
  await flushMicrotasks();
  expect(f.backend.close).toHaveBeenCalledTimes(1);
  expect(f.services.sessionService.flushOnClose).not.toHaveBeenCalled();
  expect(f.persistService.flushAll).not.toHaveBeenCalled();
});
