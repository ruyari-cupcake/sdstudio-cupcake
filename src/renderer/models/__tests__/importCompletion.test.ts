/** @jest-environment jsdom */
import path from 'path';
import {
  deferred,
  flushMicrotasks,
  loadServiceMethods,
} from '../testSupport/completionMethodHarness';

const appPath = path.resolve(__dirname, '../AppService.ts');
const backupPath = path.resolve(__dirname, '../BackupService.ts');

function appHarness() {
  const read = deferred<string>();
  const saved = deferred<void>();
  const choice = deferred<string | undefined>();
  const imported = new Map<string, any>();
  const sessionService = {
    get: jest.fn(async (name: string) => imported.get(name)),
    importSessionShallow: jest.fn(async (_json: unknown, name: string) => {
      await saved.promise;
      imported.set(name, { name });
    }),
  };
  class Reader {
    onload?: (event: any) => void;

    readAsText() {
      void read.promise.then((result) => this.onload?.({ target: { result } }));
    }

    readAsDataURL() {
      this.readAsText();
    }
  }
  const shared: any = {};
  const Subject = loadServiceMethods(appPath, 'AppState', ['handleFile'], {
    FileReader: Reader,
    readImportFile: jest.fn(() => read.promise),
    getImportFilePath: jest.fn((file: any) => file.path),
    sessionService,
    isImportImageMime: () => false,
    isValidSession: (json: any) => json?.kind === 'project',
    isValidNAISPreset: () => false,
    isValidPieceLibrary: () => false,
    promptName: jest.fn(),
    projectNameRules: () => ({}),
    nameErrorMessage: () => 'import failed',
    appState: shared,
  });
  const state: any = Object.assign(new Subject(), {
    curSession: undefined,
    pushDialog: jest.fn(),
    pushDialogAsync: jest.fn(() => choice.promise),
    pushMessage: jest.fn(),
    handleTarImport: jest.fn(),
  });
  Object.assign(shared, state);
  return { state, read, saved, choice, sessionService };
}

describe('file import completion owns its actual result', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('waits for reading and the real project write, then returns the created name', async () => {
    const { state, read, saved, sessionService } = appHarness();
    const result = state.handleFile({
      name: 'project.json',
      type: 'application/json',
    });
    // The extracted production async method runs in Node's VM realm. Awaitability
    // and actual settlement below are the contract, not this realm's constructor.
    expect(typeof result.then).toBe('function');
    let settled = false;
    void result.then(() => {
      settled = true;

      return undefined;
    });
    read.resolve(JSON.stringify({ kind: 'project', name: 'owned-project' }));
    await flushMicrotasks();
    expect(sessionService.importSessionShallow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'owned-project' }),
      'owned-project',
    );
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(settled).toBe(false);
    saved.resolve();
    await expect(result).resolves.toEqual(['owned-project']);
  });

  it('keeps the import pending while the user decides and settles cancellation without a timer', async () => {
    const { state, read, choice, sessionService } = appHarness();
    state.curSession = { name: 'current-project' };
    const result = state.handleFile({
      name: 'project.json',
      type: 'application/json',
    });
    // The extracted production async method runs in Node's VM realm. Awaitability
    // and actual settlement below are the contract, not this realm's constructor.
    expect(typeof result.then).toBe('function');
    let settled = false;
    void result.then(() => {
      settled = true;

      return undefined;
    });
    read.resolve(JSON.stringify({ kind: 'project', name: 'incoming-project' }));
    await flushMicrotasks();
    expect(state.pushDialogAsync).toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(settled).toBe(false);
    choice.resolve(undefined);
    await expect(result).resolves.toEqual([]);
    expect(sessionService.importSessionShallow).not.toHaveBeenCalled();
  });

  it('propagates completion and owned project names from a TAR import', async () => {
    const { state } = appHarness();
    const imported = deferred<string[]>();
    state.handleTarImport.mockReturnValue(imported.promise);
    const result = state.handleFile({
      name: 'folder.tar',
      path: '/chosen/folder.tar',
    });
    // The extracted production async method runs in Node's VM realm. Awaitability
    // and actual settlement below are the contract, not this realm's constructor.
    expect(typeof result.then).toBe('function');
    let settled = false;
    void result.then(() => {
      settled = true;

      return undefined;
    });
    jest.advanceTimersByTime(60_000);
    await flushMicrotasks();
    expect(settled).toBe(false);
    imported.resolve(['first', 'second']);
    await expect(result).resolves.toEqual(['first', 'second']);
  });

  it('moves only names returned by the completed import, even after the former 20 second cutoff', async () => {
    const imported = deferred<string[]>();
    const appState = {
      handleFile: jest.fn(() => imported.promise),
      pushMessage: jest.fn(),
    };
    const sessionService = Object.assign(new EventTarget(), {
      list: jest.fn(() => ['existing', 'unrelated-concurrent-project']),
      moveToFolder: jest.fn(async () => undefined),
    });
    const Subject = loadServiceMethods(
      backupPath,
      'BackupService',
      ['folderImportFile', 'waitForNewProjects'],
      {
        appState,
        sessionService,
        getFirstFile: jest.fn(async () => ({ name: 'folder.tar' })),
        setTimeout,
        clearTimeout,
      },
    );
    const result = new Subject().folderImportFile('destination');
    let settled = false;
    void result.then(() => {
      settled = true;

      return undefined;
    });
    await flushMicrotasks();
    jest.advanceTimersByTime(25_000);
    await flushMicrotasks();
    expect(settled).toBe(false);
    imported.resolve(['first', 'second']);
    await result;
    expect(sessionService.moveToFolder.mock.calls).toEqual([
      ['first', 'destination'],
      ['second', 'destination'],
    ]);
  });

  it('returns the actual names created by a multi-project TAR restore', async () => {
    const names: string[] = [];
    const sessionService = {
      listFolders: () => [],
      list: () => [...names],
      createFolder: jest.fn(async () => undefined),
      importSessionDeepFromDir: jest.fn(async (_dir: string, name: string) => {
        names.push(name);
      }),
      moveToFolder: jest.fn(async () => undefined),
    };
    const Subject = loadServiceMethods(
      backupPath,
      'BackupService',
      ['restoreFolderBackupFromDir'],
      {
        sessionService,
        backend: { deleteDir: jest.fn(async () => undefined) },
        appState: {
          setProgressDialog: jest.fn(),
          pushMessage: jest.fn(),
          pushDialog: jest.fn(),
        },
      },
    );
    await expect(
      Subject.restoreFolderBackupFromDir('tmp/import', {
        folder: 'Imported',
        projects: ['one', 'two'],
      }),
    ).resolves.toEqual(['one', 'two']);
  });
});
