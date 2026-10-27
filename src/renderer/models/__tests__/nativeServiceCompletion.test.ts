import fs from 'fs';
import path from 'path';
import { runInThisContext } from 'vm';
import ts from 'typescript';
import { loadServiceMethods } from '../testSupport/completionMethodHarness';

const modelFile = (name: string) => path.join(__dirname, '..', `${name}.ts`);
const sourcePath = (...parts: string[]) => parts.join('/');

function makeBackup(methods: string[]) {
  const appState = {
    curSession: { name: 'first' },
    pushMessage: jest.fn(),
    pushDialog: jest.fn(),
    pushDialogAsync: jest.fn().mockResolvedValue('shallow'),
    setProgressDialog: jest.fn(),
    loadExportPresets: jest.fn().mockReturnValue([]),
    saveExportPresets: jest.fn(),
  };
  const backend = {
    existFile: jest.fn().mockResolvedValue(false),
    listFilesWithStats: jest.fn().mockResolvedValue([]),
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(undefined),
    copyFile: jest.fn().mockResolvedValue(undefined),
    publishExport: jest.fn().mockResolvedValue(undefined),
    selectFile: jest.fn().mockResolvedValue('backup.tar'),
    deleteDir: jest.fn().mockResolvedValue(undefined),
  };
  const sessionService = {
    getProjectsInFolder: jest.fn().mockReturnValue(['first', 'second']),
    getFolderColor: jest.fn().mockReturnValue(null),
    list: jest.fn().mockReturnValue(['first', 'second']),
    listFolders: jest.fn().mockReturnValue([]),
    getOrderedFolders: jest.fn().mockReturnValue([]),
    getFolderOf: jest.fn().mockReturnValue('folder'),
    get: jest.fn().mockImplementation(async (name: string) => ({ name })),
    buildSessionDeepEntries: jest
      .fn()
      .mockResolvedValue([
        { path: 'projects/first.json', name: 'first/project.json' },
      ]),
    exportSessionShallow: jest.fn().mockResolvedValue({ name: 'first' }),
    importSessionShallow: jest.fn().mockResolvedValue(undefined),
    importSessionDeep: jest.fn().mockResolvedValue(undefined),
    moveToFolder: jest.fn().mockResolvedValue(undefined),
    favorites: new Set<string>(),
    saveFavorites: jest.fn().mockResolvedValue(undefined),
  };
  const zipService = {
    isZipping: false,
    zipFiles: jest.fn().mockResolvedValue(undefined),
  };
  const globalPresetService = {
    list: jest.fn().mockReturnValue([]),
    load: jest.fn(),
  };
  const Service = loadServiceMethods(
    modelFile('BackupService'),
    'BackupService',
    methods,
    {
      appState,
      backend,
      sessionService,
      zipService,
      globalPresetService,
      globalPieceService: { library: new Map(), load: jest.fn() },
      globalCharacterPresetService: { presets: [], load: jest.fn() },
      FULL_BACKUP_SETTINGS_FILES: ['global_presets.json'],
      FULL_BACKUP_SETTINGS_IMAGE_DIRS: ['global_vibes'],
      promptName: jest.fn().mockResolvedValue('imported'),
      projectNameRules: jest.fn().mockReturnValue({}),
      nameErrorMessage: (error: Error) => error.message,
      v4: () => 'generated-id',
    },
  );
  const service = new Service();
  for (const method of methods) {
    if (typeof Service[method] === 'function')
      service[method] = Service[method].bind(Service);
  }
  return {
    Service,
    service,
    appState,
    backend,
    sessionService,
    zipService,
    globalPresetService,
  };
}

function makeMigration(methods: string[]) {
  const backend = {
    existFile: jest.fn().mockResolvedValue(false),
    readFile: jest.fn(),
    listFiles: jest.fn().mockResolvedValue([]),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    renameFile: jest.fn().mockResolvedValue(undefined),
    renameDir: jest.fn().mockResolvedValue(undefined),
  };
  const setWorkspaceLayoutActive = jest.fn();
  const Service = loadServiceMethods(
    modelFile('MigrationService'),
    'MigrationService',
    methods,
    {
      backend,
      setWorkspaceLayoutActive,
      isWorkspaceLayout: () => false,
      WORKSPACE_ROOT: 'workspace',
      PROJECT_JSON_ROOT: 'projects',
      MIGRATION_LEDGER_FILE: 'migration-ledger.json',
      MIGRATION_OPTOUT_FILE: 'migration-optout.json',
      STORAGE_MARKER_FILE: 'storage-version.json',
      PROJECT_JSON_FILE: 'project.json',
      PROJECT_META_FILE: 'meta.json',
      PROJECT_IMAGE_ROOTS: ['outs'],
      projectJsonPath: (name: string) => `projects/${name}.json`,
      workspacePath: (dir: string, file: string) => `workspace/${dir}/${file}`,
      projectPath: sourcePath,
    },
  );
  const service = new Service();
  for (const method of methods) {
    if (typeof Service[method] === 'function')
      service[method] = Service[method].bind(Service);
  }
  return { Service, service, backend, setWorkspaceLayoutActive };
}

function makeWriteGuard() {
  const file = modelFile('SessionService');
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = source.statements.find(
    (node) =>
      ts.isClassDeclaration(node) && node.name?.text === 'SessionService',
  ) as ts.ClassDeclaration | undefined;
  if (!owner) throw new Error('Missing production SessionService');
  const methods = owner.members.filter(
    (node) =>
      ts.isMethodDeclaration(node) &&
      node.name &&
      ['guardResourceWrite', 'countResourceScenes'].includes(
        node.name.getText(source),
      ),
  );
  const compiled = ts.transpileModule(
    `class SessionService { #lossGuardWarned = new Set();\n${methods
      .map((node) => node.getText(source))
      .join('\n')}\n}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const backend = {
    queryProjectLock: jest.fn().mockResolvedValue({ locked: false }),
    existFile: jest.fn().mockResolvedValue(true),
    readFile: jest.fn().mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.bak')) throw new Error('backup read denied');
      return JSON.stringify({ scenes: { recoverable: {} }, inpaints: {} });
    }),
    copyFile: jest.fn().mockResolvedValue(undefined),
  };
  const appState = { storageWriteGuard: false, pushMessage: jest.fn() };
  const factory = runInThisContext(
    `(function(backend, getAppState) {${compiled}; return SessionService; })`,
    { filename: file },
  );
  const Service = factory(backend, () => appState);
  const service = new Service();
  service.isMirror = jest.fn().mockReturnValue(false);
  service.getPath = jest.fn().mockReturnValue('projects/project.json');
  service.findScenesWithImagesMissing = jest
    .fn()
    .mockResolvedValue(['recoverable']);
  Service.findScenesWithImagesMissing = service.findScenesWithImagesMissing;
  service.addSystemLog = jest.fn();
  Service.addSystemLog = service.addSystemLog;
  return { service, Service, backend };
}

describe('native service failure completion', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each(['folder', 'full'])(
    '%s backup stops when a listed project cannot be read',
    async (scope) => {
      const fixture = makeBackup([
        'folderBackupExport',
        'fullBackupExport',
        'buildSettingsEntries',
      ]);
      fixture.service.buildSettingsEntries = jest.fn().mockResolvedValue([]);
      fixture.sessionService.get.mockImplementation(async (name: string) => {
        if (name === 'second') throw new Error('project read denied');
        return { name };
      });
      if (scope === 'folder')
        await fixture.service.folderBackupExport('folder');
      else await fixture.service.fullBackupExport('noimg');
      expect(fixture.zipService.zipFiles).not.toHaveBeenCalled();
      expect(fixture.appState.pushDialog).not.toHaveBeenCalled();
      expect(fixture.appState.pushMessage).toHaveBeenCalledWith(
        expect.stringContaining('project read denied'),
        'error',
      );
      expect(fixture.appState.setProgressDialog).toHaveBeenLastCalledWith(
        undefined,
      );
    },
  );

  test.each(['file', 'image directory'])(
    'settings backup propagates %s access failure',
    async (scope) => {
      const fixture = makeBackup(['buildSettingsEntries']);
      const failure = new Error('settings access denied');
      if (scope === 'file')
        fixture.backend.existFile.mockRejectedValue(failure);
      else fixture.backend.listFilesWithStats.mockRejectedValue(failure);
      await expect(fixture.service.buildSettingsEntries()).rejects.toBe(
        failure,
      );
    },
  );

  test('global library adoption does not write owning JSON after an image copy failed', async () => {
    const fixture = makeBackup(['adoptGlobalsIfEmpty']);
    const failure = new Error('image copy denied');
    fixture.backend.existFile.mockImplementation(
      async (file: string) => file === 'restore/global_presets.json',
    );
    fixture.backend.listFilesWithStats.mockResolvedValue([
      { name: 'kept.png' },
    ]);
    fixture.backend.copyFile.mockImplementation(async (from: string) => {
      if (from.endsWith('/kept.png')) throw failure;
    });
    await expect(fixture.service.adoptGlobalsIfEmpty('restore')).rejects.toBe(
      failure,
    );
    expect(fixture.backend.copyFile).not.toHaveBeenCalledWith(
      'restore/global_presets.json',
      'global_presets.json',
    );
    expect(fixture.globalPresetService.load).not.toHaveBeenCalled();
  });

  test('folder import reports a move failure without claiming the folder import succeeded', async () => {
    const fixture = makeBackup(['folderImportDeep']);
    fixture.sessionService.moveToFolder.mockRejectedValue(
      new Error('folder move denied'),
    );
    await fixture.service.folderImportDeep('folder');
    expect(fixture.sessionService.importSessionDeep).toHaveBeenCalledWith(
      'backup.tar',
      'imported',
    );
    expect(fixture.appState.pushDialog).not.toHaveBeenCalled();
    expect(fixture.appState.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('folder move denied'),
      'error',
    );
    expect(fixture.appState.setProgressDialog).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  test('project duplication does not report completion after folder placement fails', async () => {
    const fixture = makeBackup(['duplicateProject']);
    fixture.sessionService.moveToFolder.mockRejectedValue(
      new Error('folder move denied'),
    );
    await fixture.service.duplicateProject();
    expect(
      fixture.appState.pushMessage.mock.calls.some(([message]) =>
        String(message).includes('복제되었습니다'),
      ),
    ).toBe(false);
    expect(fixture.appState.pushMessage).toHaveBeenCalledWith(
      'folder move denied',
    );
    expect(fixture.appState.setProgressDialog).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  test('settings merge rejects unreadable settings instead of treating them as absent', async () => {
    const fixture = makeBackup(['mergeSettingsFromDir']);
    const failure = new Error('settings read denied');
    fixture.backend.existFile.mockResolvedValue(true);
    fixture.backend.readFile.mockRejectedValue(failure);
    fixture.service.adoptGlobalsIfEmpty = jest
      .fn()
      .mockResolvedValue(undefined);
    await expect(fixture.service.mergeSettingsFromDir('restore')).rejects.toBe(
      failure,
    );
    expect(fixture.service.adoptGlobalsIfEmpty).not.toHaveBeenCalled();
  });

  test('project backup scan rejects unreadable image directories', async () => {
    const failure = new Error('image list denied');
    const backend = {
      listFiles: jest.fn().mockImplementation(async (folder: string) => {
        if (folder === 'outs/project/scene') throw failure;
        return [];
      }),
    };
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['buildSessionDeepEntries'],
      {
        backend,
        projectPath: sourcePath,
        isOutputImageFile: () => true,
      },
    );
    const service = new Service();
    service.getPath = jest.fn().mockReturnValue('projects/project.json');
    await expect(
      service.buildSessionDeepEntries({
        name: 'project',
        scenes: new Map([['scene', { name: 'scene' }]]),
        inpaints: new Map(),
      }),
    ).rejects.toBe(failure);
  });

  test.each(['legacy', 'current'])(
    'shallow import stops before registration if a %s preset image cannot be saved',
    async (shape) => {
      const failure = new Error('preset image write denied');
      const backend = { writeDataFile: jest.fn().mockRejectedValue(failure) };
      const Service = loadServiceMethods(
        modelFile('SessionService'),
        'SessionService',
        ['importSessionShallow'],
        {
          backend,
          projectPath: sourcePath,
          isWorkspaceLayout: () => false,
          v4: () => 'new-image',
        },
      );
      const service = new Service();
      service.isLoaded = jest.fn().mockReturnValue(false);
      service.list = jest.fn().mockReturnValue([]);
      service.createFrom = jest.fn();
      const preset = { type: 'style', profile: 'original-base64' };
      await expect(
        service.importSessionShallow(
          {
            presets: shape === 'legacy' ? [preset] : { SDImageGen: [preset] },
          },
          'imported',
        ),
      ).rejects.toBe(failure);
      expect(service.createFrom).not.toHaveBeenCalled();
      expect(preset.profile).toBe('original-base64');
    },
  );

  test.each(['workspace', 'legacy'])(
    'fresh-storage activation stops when %s storage inspection fails',
    async (scope) => {
      const fixture = makeMigration([
        'markFreshAndActivate',
        'hasWorkspaceData',
        'hasLegacyTraces',
      ]);
      const failure = new Error('storage inspection denied');
      fixture.backend.listFiles.mockImplementation(async (folder: string) => {
        if (folder === (scope === 'workspace' ? 'workspace' : 'projects'))
          throw failure;
        return [];
      });
      fixture.service.writeMarker = jest.fn().mockResolvedValue(undefined);
      await expect(fixture.service.markFreshAndActivate()).rejects.toBe(
        failure,
      );
      expect(fixture.setWorkspaceLayoutActive).not.toHaveBeenCalled();
      expect(fixture.service.writeMarker).not.toHaveBeenCalled();
    },
  );

  test('migration ledger permits a genuinely missing file', async () => {
    const fixture = makeMigration(['loadLedger']);
    await expect(fixture.service.loadLedger()).resolves.toEqual({
      version: 1,
      startedAt: expect.any(Number),
      projects: {},
    });
  });

  test.each(['read failure', 'invalid JSON'])(
    'migration ledger rejects an existing file with %s',
    async (kind) => {
      const fixture = makeMigration(['loadLedger']);
      fixture.backend.existFile.mockResolvedValue(true);
      if (kind === 'read failure')
        fixture.backend.readFile.mockRejectedValue(
          new Error('ledger read denied'),
        );
      else fixture.backend.readFile.mockResolvedValue('{invalid');
      await expect(fixture.service.loadLedger()).rejects.toThrow();
    },
  );

  test('unreadable folder order remains untouched while adding migration folders', async () => {
    const fixture = makeMigration(['supplementEmptyFolders']);
    fixture.backend.existFile.mockResolvedValue(true);
    fixture.backend.readFile.mockRejectedValue(
      new Error('folder order read denied'),
    );
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await fixture.service.supplementEmptyFolders(['new-folder']);
    expect(fixture.backend.writeFile).not.toHaveBeenCalled();
  });

  test('incomplete rollback keeps the workspace layout marker active', async () => {
    const fixture = makeMigration(['rollbackMigration']);
    fixture.service.loadLedger = jest.fn().mockResolvedValue({
      version: 1,
      projects: {
        first: {
          state: 'done',
          dir: 'id',
          originalName: 'first',
          logicalName: 'first',
        },
      },
    });
    fixture.Service.loadLedger = fixture.service.loadLedger;
    fixture.backend.existFile.mockResolvedValue(true);
    fixture.backend.renameFile.mockRejectedValue(new Error('rollback denied'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(fixture.service.rollbackMigration()).rejects.toThrow();
    expect(fixture.backend.deleteFile).not.toHaveBeenCalledWith(
      'storage-version.json',
    );
    expect(fixture.setWorkspaceLayoutActive).not.toHaveBeenCalled();
  });

  test('migration opt-out write failure is reported to the caller', async () => {
    const fixture = makeMigration(['writeOptOut']);
    const failure = new Error('opt-out write denied');
    fixture.backend.writeFile.mockRejectedValue(failure);
    await expect(fixture.service.writeOptOut()).rejects.toBe(failure);
  });

  test('migration opt-out reset failure is reported to the caller', async () => {
    const fixture = makeMigration(['clearOptOut']);
    const failure = new Error('opt-out delete denied');
    fixture.backend.existFile.mockResolvedValue(true);
    fixture.backend.deleteFile.mockRejectedValue(failure);
    await expect(fixture.service.clearOptOut()).rejects.toBe(failure);
  });

  test('migration diagnostics propagate failure to read an existing marker', async () => {
    const fixture = makeMigration([
      'readDiagStatus',
      'readOptOut',
      'loadLedger',
    ]);
    const failure = new Error('marker read denied');
    fixture.backend.existFile.mockResolvedValue(true);
    fixture.backend.readFile.mockRejectedValue(failure);
    await expect(fixture.service.readDiagStatus()).rejects.toBe(failure);
  });

  test('folder duplication reports an image copy failure while preserving completed copies', async () => {
    const backend = {
      listFiles: jest.fn().mockImplementation(async (folder: string) => {
        if (folder === 'outs/first' || folder === 'outs/second')
          return ['scene'];
        if (folder.endsWith('/scene')) return ['image.png'];
        return [];
      }),
      copyFile: jest.fn().mockImplementation(async (from: string) => {
        if (from.includes('/second/'))
          throw new Error('folder image copy denied');
      }),
    };
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['cloneFolder'],
      {
        backend,
        projectPath: sourcePath,
      },
    );
    const service = new Service();
    Object.assign(service, {
      folderList: ['source'],
      folderMap: { first: 'source', second: 'source' },
      getProjectsInFolder: jest.fn().mockReturnValue(['first', 'second']),
      createFolder: jest.fn().mockResolvedValue(undefined),
      get: jest.fn().mockImplementation(async (name: string) => ({ name })),
      list: jest.fn().mockReturnValue(['first', 'second']),
      exportSessionShallow: jest.fn().mockResolvedValue({}),
      importSessionShallow: jest.fn().mockResolvedValue(undefined),
      moveToFolder: jest.fn().mockResolvedValue(undefined),
      deleteFolder: jest.fn().mockResolvedValue(undefined),
    });
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(service.cloneFolder('source', 'target', true)).rejects.toThrow(
      'second',
    );
    expect(backend.copyFile).toHaveBeenCalledWith(
      'outs/first/scene/image.png',
      'outs/first (2)/scene/image.png',
    );
    expect(service.deleteFolder).not.toHaveBeenCalled();
  });

  test('shallow export rejects an unreadable referenced preset image', async () => {
    const failure = new Error('profile read denied');
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['exportSessionShallow'],
      {
        imageService: { fetchVibeImage: jest.fn().mockRejectedValue(failure) },
        dataUriToBase64: jest.fn(),
      },
    );
    const service = new Service();
    await expect(
      service.exportSessionShallow({
        toJSON: () => ({
          presetShareds: {},
          scenes: {},
          presets: { SDImageGen: [{ profile: 'kept.png' }] },
        }),
      }),
    ).rejects.toBe(failure);
  });

  test('legacy favorites read failure cannot silently reset the favorites state', async () => {
    const failure = new Error('legacy favorites read denied');
    const backend = {
      existFile: jest
        .fn()
        .mockImplementation(
          async (file: string) => file === 'projects/favorites.json',
        ),
      readFile: jest.fn().mockRejectedValue(failure),
    };
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['loadFavorites'],
      { backend },
    );
    const service = new Service();
    service.metaLoadFailed = new Set();
    service.favorites = new Set(['kept']);
    service.markMetaLoadError = jest.fn();
    service.saveFavorites = jest.fn();
    await expect(service.loadFavorites()).rejects.toBe(failure);
    expect(service.favorites).toEqual(new Set(['kept']));
    expect(service.saveFavorites).not.toHaveBeenCalled();
    expect(service.markMetaLoadError).toHaveBeenCalledWith(
      'favorites.json',
      failure,
    );
  });

  test('write guard never overwrites an unreadable existing recovery backup', async () => {
    const { service, backend } = makeWriteGuard();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      service.guardResourceWrite(
        'project',
        JSON.stringify({ scenes: {}, inpaints: {} }),
      ),
    ).resolves.toBe('skip');
    expect(backend.copyFile).not.toHaveBeenCalled();
  });

  test('closing flush rejects failed project writes after allowing the remaining writes to finish', async () => {
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['flushOnClose'],
      {
        getAppState: () => ({ curSession: undefined }),
      },
    );
    const service = new Service();
    service.dirtyNames = jest.fn().mockReturnValue(['first', 'second']);
    service.markDirty = jest.fn();
    service.writeResource = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'first') throw new Error('project write denied');
      });
    service.refreshLoadedThumbnails = jest.fn().mockResolvedValue(undefined);
    service.saveThumbnails = jest.fn().mockResolvedValue(undefined);
    await expect(service.flushOnClose()).rejects.toThrow('first');
    expect(service.writeResource).toHaveBeenCalledWith('second');
  });

  test('unknown cross-window lock state defers a project write', async () => {
    const { service, backend } = makeWriteGuard();
    backend.queryProjectLock.mockRejectedValue(
      new Error('lock query unavailable'),
    );
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      service.guardResourceWrite(
        'project',
        JSON.stringify({ scenes: {}, inpaints: {} }),
      ),
    ).resolves.toBe('skip-keep');
    expect(backend.copyFile).not.toHaveBeenCalled();
  });

  test('a write guard error keeps the resource pending without writing through it', async () => {
    const persistService = { write: jest.fn().mockResolvedValue(undefined) };
    const Service = loadServiceMethods(
      modelFile('ResourceSyncService'),
      'ResourceSyncService',
      ['writeResource'],
      { persistService },
    );
    const service = new Service();
    service.entries = new Map([
      [
        'project',
        {
          instance: { toJSON: () => ({ name: 'project' }) },
          state: 'ready',
          dirty: true,
          seq: 1,
        },
      ],
    ]);
    service.guardResourceWrite = jest
      .fn()
      .mockRejectedValue(new Error('guard failed'));
    service.storage = {};
    service.getPath = jest.fn().mockReturnValue('projects/project.json');
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(service.writeResource('project')).resolves.toBe('retry');
    expect(persistService.write).not.toHaveBeenCalled();
    expect(service.entries.get('project').dirty).toBe(true);
  });

  test.each(['flush', 'flushAllNow'])(
    '%s preserves dirty state when a write rejects',
    async (method) => {
      const Service = loadServiceMethods(
        modelFile('ResourceSyncService'),
        'ResourceSyncService',
        [method],
        {},
      );
      const service = new Service();
      service.entries = new Map([
        [
          'project',
          {
            instance: {},
            state: 'ready',
            dirty: true,
            seq: 1,
          },
        ],
      ]);
      service.writeResource = jest
        .fn()
        .mockRejectedValue(new Error('resource write denied'));
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await service[method]();
      expect(service.entries.get('project').dirty).toBe(true);
    },
  );

  test('closing flush refuses completion when a project write is waiting for a retry', async () => {
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['flushOnClose'],
      {
        getAppState: () => ({ curSession: undefined }),
      },
    );
    const service = new Service();
    service.dirtyNames = jest.fn().mockReturnValue(['project']);
    service.writeResource = jest.fn().mockResolvedValue('retry');
    service.markDirty = jest.fn();
    service.refreshLoadedThumbnails = jest.fn().mockResolvedValue(undefined);
    service.saveThumbnails = jest.fn().mockResolvedValue(undefined);
    await expect(service.flushOnClose()).rejects.toThrow('project');
  });

  test('a batch project remains created but is reported failed when final folder placement fails', async () => {
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['batchCreateFromTemplate'],
      {
        projectTemplateService: {
          ensureLoaded: jest.fn().mockResolvedValue(undefined),
        },
        resolveBatchName: (name: string) => name,
      },
    );
    const service = new Service();
    service.list = jest.fn().mockReturnValue([]);
    service.folderList = ['target'];
    service.createSessionFromProjectTemplate = jest
      .fn()
      .mockResolvedValue(undefined);
    service.moveToFolder = jest
      .fn()
      .mockRejectedValue(new Error('folder move denied'));
    service.delete = jest.fn();
    const result = await service.batchCreateFromTemplate({
      templateId: 'template',
      folder: 'target',
      items: [{ name: 'created' }],
    });
    expect(service.createSessionFromProjectTemplate).toHaveBeenCalled();
    expect(service.delete).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.failed).toEqual([
      { name: 'created', error: expect.stringContaining('folder move denied') },
    ]);
  });

  test('structural lock checks propagate an unavailable lock service', async () => {
    const failure = new Error('lock query unavailable');
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['guardCrossWindowLock'],
      {
        backend: { queryProjectLock: jest.fn().mockRejectedValue(failure) },
      },
    );
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      new Service().guardCrossWindowLock('project', '폴더 이동'),
    ).rejects.toBe(failure);
  });

  test('folder movement rejects a lock refusal instead of reporting a completed move', async () => {
    const Service = loadServiceMethods(
      modelFile('SessionService'),
      'SessionService',
      ['moveToFolder'],
      {},
    );
    const service = new Service();
    service.guardCrossWindowLock = jest.fn().mockResolvedValue(false);
    service.updateWorkspaceMeta = jest.fn();
    await expect(service.moveToFolder('project', 'target')).rejects.toThrow();
    expect(service.updateWorkspaceMeta).not.toHaveBeenCalled();
  });

  test('OS trash fallback counts failures and preserves failed source cache', async () => {
    const file = modelFile('ImageService');
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const declaration = source.statements
      .flatMap((node) =>
        ts.isVariableStatement(node)
          ? [...node.declarationList.declarations]
          : [],
      )
      .find((node) => node.name.getText(source) === 'deleteImageFiles');
    if (!declaration?.initializer)
      throw new Error('Missing production deleteImageFiles');
    const compiled = ts.transpileModule(
      `const deleteImageFiles = ${declaration.initializer.getText(source)}`,
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      },
    ).outputText;
    const backend = {
      trashFile: jest.fn().mockImplementation(async (filePath: string) => {
        if (filePath === 'denied.png') throw new Error('trash denied');
      }),
    };
    const imageService = {
      invalidateCache: jest.fn().mockResolvedValue(undefined),
      refreshBatch: jest.fn().mockResolvedValue(undefined),
    };
    const appState = { pushMessage: jest.fn() };
    const factory = runInThisContext(
      `(function(backend, imageService, getAppState) {${
        compiled
      }; return deleteImageFiles; })`,
      { filename: file },
    );
    const remove = factory(backend, imageService, () => appState);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      remove({ name: 'project' }, ['denied.png', 'removed.png']),
    ).resolves.toBe(1);
    expect(imageService.invalidateCache).not.toHaveBeenCalledWith('denied.png');
    expect(imageService.invalidateCache).toHaveBeenCalledWith('removed.png');
    expect(imageService.refreshBatch).toHaveBeenCalled();
    expect(appState.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('1'),
    );
  });
});
