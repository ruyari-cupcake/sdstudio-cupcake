/** @jest-environment jsdom */
import path from 'path';
import loadFunctionFixture from '../../componenets/testSupport/functionFixture';
import {
  deferred,
  flushMicrotasks,
} from '../testSupport/completionMethodHarness';

function closeFixture(templatesLoaded = true) {
  let onClose: (() => void) | undefined;
  const closed = deferred<void>();
  const reported = deferred<void>();
  const writes = [
    jest.fn<Promise<void>, []>(async () => undefined),
    jest.fn<Promise<void>, []>(async () => undefined),
    jest.fn<Promise<void>, []>(async () => undefined),
    jest.fn<Promise<void>, []>(async () => undefined),
    jest.fn<Promise<void>, []>(async () => undefined),
    jest.fn<Promise<void>, []>(async () => undefined),
    jest.fn<Promise<void>, []>(async () => undefined),
    jest.fn<Promise<void>, []>(async () => undefined),
  ];
  const backend = {
    onClose: jest.fn((handler: () => void) => {
      onClose = handler;
    }),
    close: jest.fn<Promise<void>, []>(async () => {
      closed.resolve();
    }),
    updates: {
      cancelInstall: jest.fn<Promise<void>, []>(async () => undefined),
    },
  };
  const appUpdateNoticeService = {
    phase: 'idle',
    failInstall: jest.fn<void, [unknown]>(),
  };
  const appState = {
    storageLocationChange: null as {
      path: string;
      phase: 'saving' | 'restarting';
      error?: string;
    } | null,
    pushMessage: jest.fn(() => {
      reported.resolve();
    }),
  };
  const errors = { error: jest.fn() };
  const bindings = {
    backend,
    appState,
    appUpdateNoticeService,
    console: errors,
    sessionService: { flushOnClose: writes[0] },
    globalPresetService: { flushSave: writes[1] },
    globalPieceService: { flushSave: writes[2] },
    globalCharacterPresetService: { flushSave: writes[3] },
    artistLibraryService: { flushSave: writes[4] },
    projectTemplateService: { loaded: templatesLoaded, flushSave: writes[7] },
    taskQueueService: { flushSaveLogs: writes[5] },
    persistService: { flushAll: writes[6] },
  };
  const file = path.resolve(__dirname, '../bootstrap.ts');
  const flushApplicationStorage = loadFunctionFixture(
    file,
    { name: 'flushApplicationStorage' },
    bindings,
  );
  const register = loadFunctionFixture(
    file,
    { name: 'registerOnCloseFlush' },
    { ...bindings, flushApplicationStorage },
  );
  register();
  return {
    close: () => onClose?.(),
    writes,
    backend,
    appState,
    appUpdateNoticeService,
    closed,
    reported,
  };
}

test('a failed native close acknowledgement after a committed root change exposes restart retry without rewriting the old root', async () => {
  const f = closeFixture();
  f.appState.storageLocationChange = { path: 'D:/chosen', phase: 'restarting' };
  f.backend.close.mockRejectedValueOnce(new Error('native close refused'));
  f.close();
  await f.reported.promise;
  expect(f.appState.storageLocationChange).toEqual({
    path: 'D:/chosen',
    phase: 'restarting',
    error: expect.stringContaining('native close refused'),
  });
  for (const write of f.writes) expect(write).not.toHaveBeenCalled();
  f.close();
  await f.closed.promise;
  expect(f.backend.close).toHaveBeenCalledTimes(2);
  for (const write of f.writes) expect(write).not.toHaveBeenCalled();
});

test('closing while storage-change saves are in progress waits for that owner', async () => {
  const f = closeFixture();
  f.appState.storageLocationChange = { path: 'D:/chosen', phase: 'saving' };
  f.close();
  await flushMicrotasks();
  expect(f.backend.close).not.toHaveBeenCalled();
  for (const write of f.writes) expect(write).not.toHaveBeenCalled();
});

test('a failed final write keeps the app open, reports the failure and permits a later close retry', async () => {
  const f = closeFixture();
  f.writes[0].mockRejectedValueOnce(new Error('disk write denied'));
  f.close();
  await f.reported.promise;
  expect(f.backend.close).not.toHaveBeenCalled();
  expect(f.appState.pushMessage).toHaveBeenCalledWith(
    expect.stringContaining('종료'),
    'error',
  );
  f.close();
  await f.closed.promise;
  expect(f.writes[0]).toHaveBeenCalledTimes(2);
  for (const write of f.writes.slice(1)) expect(write).toHaveBeenCalledTimes(1);
  expect(f.backend.close).toHaveBeenCalledTimes(1);
});

test('a failed update close cancels the prepared installer and returns the save error to the updater', async () => {
  const f = closeFixture();
  f.appUpdateNoticeService.phase = 'installing';
  const failure = new Error('update save denied');
  f.writes[0].mockRejectedValueOnce(failure);
  f.close();
  await f.reported.promise;
  expect(f.backend.close).not.toHaveBeenCalled();
  expect(f.backend.updates.cancelInstall).toHaveBeenCalledTimes(1);
  expect(f.appUpdateNoticeService.failInstall).toHaveBeenCalledWith(failure);
  expect(
    f.backend.updates.cancelInstall.mock.invocationCallOrder[0],
  ).toBeLessThan(
    f.appUpdateNoticeService.failInstall.mock.invocationCallOrder[0],
  );
  for (const write of f.writes.slice(1)) expect(write).not.toHaveBeenCalled();
});

test('an unopened template store is not replaced with an empty snapshot on close', async () => {
  const f = closeFixture(false);
  f.close();
  await f.closed.promise;
  expect(f.writes[7]).not.toHaveBeenCalled();
  expect(f.backend.close).toHaveBeenCalledTimes(1);
});

test('a pending template save delays close and a failed template save permits retry', async () => {
  const f = closeFixture();
  const pending = deferred<void>();
  const entered = deferred<void>();
  f.writes[7].mockImplementationOnce(() => {
    entered.resolve();
    return pending.promise;
  });
  f.close();
  await Promise.race([entered.promise, f.closed.promise]);
  expect(f.writes[7]).toHaveBeenCalledTimes(1);
  expect(f.backend.close).not.toHaveBeenCalled();
  pending.reject(new Error('template replacement denied'));
  await f.reported.promise;
  expect(f.backend.close).not.toHaveBeenCalled();
  expect(f.appState.pushMessage).toHaveBeenCalledWith(
    expect.stringContaining('종료'),
    'error',
  );
  f.close();
  await f.closed.promise;
  expect(f.writes[7]).toHaveBeenCalledTimes(2);
  expect(f.backend.close).toHaveBeenCalledTimes(1);
});

test('repeated native close requests share one actual pending flush and close only after every store settles', async () => {
  const f = closeFixture();
  const pending = deferred<void>();
  f.writes[0].mockReturnValueOnce(pending.promise);
  f.close();
  f.close();
  await flushMicrotasks();
  expect(f.writes[0]).toHaveBeenCalledTimes(1);
  expect(f.backend.close).not.toHaveBeenCalled();
  pending.resolve();
  await f.closed.promise;
  for (const write of f.writes) expect(write).toHaveBeenCalledTimes(1);
  expect(f.backend.close).toHaveBeenCalledTimes(1);
});
