import { CharacterPreset } from '../CharacterPreset';

type StoreKind = 'styles' | 'characters' | 'templates' | 'artists';
type Store = {
  loaded: boolean;
  load(): Promise<void>;
  save(): Promise<void>;
};

jest.mock('..', () => {
  throw new Error('Store load tests use explicit dependencies');
});

function fixture(kind: StoreKind) {
  const character = new CharacterPreset();
  character.name = 'Kept character';
  const files = new Map<string, string>();
  const storage = {
    existFile: jest.fn(async (path: string) => files.has(path)),
    readFile: jest.fn(async (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new Error('Missing fixture file');
      return contents;
    }),
    writeFile: jest.fn(async (path: string, data: string) => {
      files.set(path, data);
    }),
    renameFile: jest.fn(async (from: string, to: string) => {
      const contents = files.get(from);
      if (contents === undefined) throw new Error('Missing fixture file');
      files.set(to, contents);
      files.delete(from);
    }),
    copyFile: jest.fn(async () => undefined),
    deleteFile: jest.fn(async () => undefined),
    deleteDir: jest.fn(async () => undefined),
    readDataFile: jest.fn(async () => ''),
    writeDataFile: jest.fn(async () => undefined),
    notifyGlobalStoreChanged: jest.fn(async () => undefined),
  };
  const images = {
    fetchVibeImage: jest.fn(),
    storeVibeImage: jest.fn(),
    getVibeImagePath: jest.fn(),
    getReferenceImagePath: jest.fn(),
    storeReferenceImage: jest.fn(),
  };
  const workflows = {
    buildPreset: jest.fn(),
    presetFromJSON: jest.fn(),
    buildShared: jest.fn(),
  };
  const templateDependencies = {
    backend: storage,
    imageService: images,
    workFlowService: workflows,
    sessionService: { get: jest.fn() },
    templateService: {
      clearFolderTemplatesByTemplateId: jest.fn(async () => undefined),
      clearApplicationsByTemplateId: jest.fn(async () => undefined),
    },
    globalPresetService: { get: jest.fn() },
    globalCharacterPresetService: { get: jest.fn(), fetchImageData: jest.fn() },
  };
  let store: Store;
  let entries: () => unknown[];
  let file: string;
  let data: unknown;
  if (kind === 'styles') {
    const { GlobalPresetService } = jest.requireActual<
      typeof import('../GlobalPresetService')
    >('../GlobalPresetService');
    const service = new GlobalPresetService(storage, images, workflows);
    store = service;
    entries = () => service.presets;
    file = 'global_presets.json';
    data = {
      version: 2,
      presets: [
        {
          id: 'kept',
          name: 'Kept style',
          workflowType: 'SDImageGenEasy',
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
          preset: { frontPrompt: 'kept' },
        },
      ],
    };
  } else if (kind === 'characters') {
    const { GlobalCharacterPresetService } = jest.requireActual<
      typeof import('../GlobalCharacterPresetService')
    >('../GlobalCharacterPresetService');
    const service = new GlobalCharacterPresetService(storage, images);
    store = service;
    entries = () => service.presets;
    file = 'global_character_presets.json';
    data = {
      version: 1,
      presets: [
        {
          id: 'kept',
          name: 'Kept character',
          createdAt: 1,
          updatedAt: 1,
          preset: character.toJSON(),
        },
      ],
      folders: ['Kept folder'],
    };
  } else if (kind === 'templates') {
    const { ProjectTemplateService } = jest.requireActual<
      typeof import('../ProjectTemplateService')
    >('../ProjectTemplateService');
    const service = new ProjectTemplateService(templateDependencies);
    store = service;
    entries = () => service.templates;
    file = 'project_templates.json';
    data = {
      version: 1,
      templates: [
        {
          id: 'kept',
          name: 'Kept template',
          createdAt: 1,
          updatedAt: 1,
          preset: null,
          characterPresets: [],
          vibes: [],
          characterReferences: [],
          scenes: [],
        },
      ],
    };
  } else {
    const { ArtistLibraryService } = jest.requireActual<
      typeof import('../ArtistLibraryService')
    >('../ArtistLibraryService');
    const service = new ArtistLibraryService(storage);
    store = service;
    entries = () => service.artists;
    file = 'artist_library.json';
    data = {
      version: 1,
      artists: [
        {
          id: 'kept',
          name: 'Kept artist',
          images: [],
          tags: ['#kept'],
          favorite: false,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      tagPresets: ['#kept'],
    };
  }
  files.set(file, JSON.stringify(data));
  return { store, entries, file, files, storage, templateDependencies };
}

describe.each<StoreKind>(['styles', 'characters', 'templates', 'artists'])(
  '%s store load ownership',
  (kind) => {
    it('retains last good data and blocks writes after a read failure until an explicit successful reload', async () => {
      const f = fixture(kind);
      await f.store.load();
      const before = JSON.stringify(f.entries());
      const onDisk = f.files.get(f.file);
      const error = Object.assign(new Error('read denied'), { code: 'EACCES' });
      f.storage.readFile.mockRejectedValue(error);

      await expect(f.store.load()).rejects.toBe(error);
      expect(f.store.loaded).toBe(false);
      expect(JSON.stringify(f.entries())).toBe(before);
      await expect(f.store.save()).rejects.toBe(error);
      expect(f.storage.writeFile).not.toHaveBeenCalled();
      expect(f.storage.renameFile).not.toHaveBeenCalled();
      expect(f.files.get(f.file)).toBe(onDisk);

      f.storage.readFile.mockImplementation(async (path: string) => {
        const contents = f.files.get(path);
        if (contents === undefined) throw new Error('Missing fixture file');
        return contents;
      });
      await f.store.load();
      await f.store.save();
      expect(f.store.loaded).toBe(true);
      expect(JSON.stringify(f.entries())).toBe(before);
      expect(f.storage.writeFile).toHaveBeenCalledWith(
        `${f.file}.tmp`,
        expect.any(String),
      );
    });

    it('propagates an existence probe failure without treating it as a new empty store', async () => {
      const f = fixture(kind);
      const error = Object.assign(new Error('probe denied'), {
        code: 'EACCES',
      });
      f.storage.existFile.mockRejectedValue(error);
      await expect(f.store.load()).rejects.toBe(error);
      await expect(f.store.save()).rejects.toBe(error);
      expect(f.storage.readFile).not.toHaveBeenCalled();
      expect(f.storage.writeFile).not.toHaveBeenCalled();
      expect(f.store.loaded).toBe(false);
    });

    it('allows a confirmed missing file to start empty and be saved', async () => {
      const f = fixture(kind);
      f.files.delete(f.file);
      await f.store.load();
      expect(f.store.loaded).toBe(true);
      expect(f.entries()).toEqual([]);
      await f.store.save();
      expect(f.files.has(f.file)).toBe(true);
    });

    it('preserves corrupt bytes and blocks saving if their recovery rename fails', async () => {
      const f = fixture(kind);
      f.files.set(f.file, '{corrupt');
      const error = Object.assign(new Error('backup rename denied'), {
        code: 'EACCES',
      });
      f.storage.renameFile.mockRejectedValue(error);
      await expect(f.store.load()).rejects.toBe(error);
      await expect(f.store.save()).rejects.toBe(error);
      expect(f.files.get(f.file)).toBe('{corrupt');
      expect(f.storage.writeFile).not.toHaveBeenCalled();
    });
  },
);

it('coalesces concurrent explicit loads and prevents saving while the read is unresolved', async () => {
  const f = fixture('characters');
  let resolveRead!: (contents: string) => void;
  let enteredRead!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredRead = resolve;
  });
  const pending = new Promise<string>((resolve) => {
    resolveRead = resolve;
  });
  f.storage.readFile.mockImplementation(() => {
    enteredRead();
    return pending;
  });
  const first = f.store.load();
  const second = f.store.load();
  await entered;
  await expect(f.store.save()).rejects.toThrow('불러오는 중');
  expect(f.storage.writeFile).not.toHaveBeenCalled();
  resolveRead(f.files.get(f.file)!);
  await Promise.all([first, second]);
  expect(f.storage.readFile).toHaveBeenCalledTimes(1);
});

describe.each(['vibes', 'characterReferences'] as const)(
  'template %s row ownership',
  (kind) => {
    it('retains duplicate-path row identity and the shared file until the final reference is removed', async () => {
      jest.useFakeTimers();
      try {
        const f = fixture('templates');
        const { ProjectTemplateService } = jest.requireActual<
          typeof import('../ProjectTemplateService')
        >('../ProjectTemplateService');
        const service = new ProjectTemplateService(f.templateDependencies);
        await service.load();
        const entry = service.get('kept')!;
        entry[kind] = [
          {
            path: 'shared.png',
            info: 1,
            strength: 0.4,
            fidelity: 1,
            referenceType: 'character',
          },
          {
            path: 'shared.png',
            info: 1,
            strength: 0.6,
            fidelity: 1,
            referenceType: 'character',
          },
        ];
        const first = entry[kind][0];
        const second = entry[kind][1];
        if (kind === 'vibes')
          await service.updateVibe('kept', 1, { strength: 0.8 });
        else
          await service.updateCharacterReference('kept', 1, { strength: 0.8 });
        expect(entry[kind][0]).toBe(first);
        expect(entry[kind][1]).toBe(second);
        expect(second.strength).toBe(0.8);

        if (kind === 'vibes') await service.removeVibe('kept', 0);
        else await service.removeCharacterReference('kept', 0);
        expect(entry[kind][0]).toBe(second);
        expect(f.storage.deleteFile).not.toHaveBeenCalled();

        if (kind === 'vibes') await service.removeVibe('kept', 0);
        else await service.removeCharacterReference('kept', 0);
        expect(f.storage.deleteFile).toHaveBeenCalledTimes(1);
        expect(f.storage.deleteFile).toHaveBeenCalledWith(
          'project_template_images/shared.png',
        );
      } finally {
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    });
  },
);
