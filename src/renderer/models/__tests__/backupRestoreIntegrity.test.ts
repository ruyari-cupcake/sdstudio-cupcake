/** @jest-environment jsdom */
import path from 'path';
import { PersistenceService } from '../PersistenceService';
import {
  deferred,
  flushMicrotasks,
  loadServiceMethods,
} from '../testSupport/completionMethodHarness';

function restoreFixture(kind: 'preset' | 'artist') {
  const isPreset = kind === 'preset';
  const className = isPreset ? 'GlobalPresetService' : 'ArtistLibraryService';
  const file = path.resolve(__dirname, `../${className}.ts`);
  let sequence = 0;
  const events: string[] = [];
  const original = isPreset
    ? {
        id: 'old',
        name: 'Same',
        workflowType: 'SDImageGen',
        profile: 'old.png',
        preset: {},
      }
    : {
        id: 'old',
        name: 'Same',
        images: [{ id: 'old-image', path: 'artist_library/old/old.png' }],
        tags: [],
      };
  const incoming = isPreset
    ? {
        name: 'Same',
        workflowType: 'SDImageGen',
        profile: 'incoming.png',
        preset: {},
      }
    : {
        name: 'Same',
        images: [{ path: 'artist_library/source/incoming.png' }],
        tags: ['incoming'],
      };
  const key = isPreset ? 'presets' : 'artists';
  const backend = {
    readFile: jest.fn(async () =>
      JSON.stringify({ [key]: [incoming], tagPresets: ['incoming'] }),
    ),
    existFile: jest.fn(async () => true),
    copyFile: jest.fn<Promise<void>, [string, string]>(async (_from, dest) => {
      events.push(`copy:${dest}`);
    }),
    deleteFile: jest.fn<Promise<void>, [string]>(async (filePath) => {
      events.push(`delete:${filePath}`);
    }),
    deleteDir: jest.fn<Promise<void>, [string]>(async (filePath) => {
      events.push(`delete:${filePath}`);
    }),
  };
  const Subject = loadServiceMethods(
    file,
    className,
    ['restoreFromBackupDir'],
    {
      action: (method: unknown) => method,
      uuidv4: () => `new-${++sequence}`,
      GLOBAL_VIBES_DIR: 'global_vibes',
      ARTIST_LIBRARY_DIR: 'artist_library',
      CustomEvent,
      console: { warn: jest.fn(), error: jest.fn() },
    },
  );
  const service: any = Object.assign(new Subject(), {
    backend,
    [key]: [original],
    tagPresets: ['kept'],
    getProfilePath: (token: string) => `global_vibes/${token}`,
    dispatchEvent: jest.fn(),
    scheduleSave: jest.fn(),
    flushSave: jest.fn<Promise<void>, []>(async () => {
      events.push('commit');
    }),
  });
  service.deleteProfileImage = (token: string) =>
    backend.deleteFile(`global_vibes/${token}`);
  service.delete = async () => {
    service.presets = [];
    await backend.deleteFile('global_vibes/old.png');
  };
  service.deleteArtist = async () => {
    service.artists = [];
    await backend.deleteDir('artist_library/old');
  };
  return { service, backend, events, original, key };
}

describe.each(['preset', 'artist'] as const)(
  '%s backup restore preserves existing data',
  (kind) => {
    test('a failed image copy rejects and preserves the overwritten entry and original files', async () => {
      const f = restoreFixture(kind);
      f.backend.copyFile.mockRejectedValueOnce(new Error('copy denied'));
      await expect(
        f.service.restoreFromBackupDir('backup', 'overwrite'),
      ).rejects.toThrow('copy denied');
      expect(f.service[f.key]).toEqual([f.original]);
      expect(
        f.events.some(
          (event) =>
            event === 'delete:global_vibes/old.png' ||
            event === 'delete:artist_library/old',
        ),
      ).toBe(false);
      expect(f.service.flushSave).not.toHaveBeenCalled();
    });

    test('a failed manifest commit rejects, rolls back the list and keeps original images', async () => {
      const f = restoreFixture(kind);
      f.service.flushSave.mockRejectedValueOnce(new Error('manifest denied'));
      await expect(
        f.service.restoreFromBackupDir('backup', 'overwrite'),
      ).rejects.toThrow('manifest denied');
      expect(f.service[f.key]).toEqual([f.original]);
      expect(f.service.tagPresets).toEqual(['kept']);
      expect(
        f.events.some(
          (event) =>
            event === 'delete:global_vibes/old.png' ||
            event === 'delete:artist_library/old',
        ),
      ).toBe(false);
      expect(
        f.events.some(
          (event) => event.startsWith('delete:') && event.includes('new-'),
        ),
      ).toBe(true);
    });

    test('replacement images and metadata finish before the previous images are removed', async () => {
      const f = restoreFixture(kind);
      const pending = deferred<void>();
      f.service.flushSave.mockImplementationOnce(async () => {
        await pending.promise;
        f.events.push('commit');
      });
      const result = f.service.restoreFromBackupDir('backup', 'overwrite');
      await flushMicrotasks();
      expect(f.service.flushSave).toHaveBeenCalledTimes(1);
      expect(f.events.some((event) => event.startsWith('delete:'))).toBe(false);
      pending.resolve();
      await expect(result).resolves.toEqual({
        added: 1,
        skipped: 0,
        overwritten: 1,
      });
      expect(
        f.events.findIndex((event) => event.startsWith('delete:')),
      ).toBeGreaterThan(f.events.indexOf('commit'));
      expect(f.service[f.key]).toHaveLength(1);
      expect(f.service[f.key][0].id).not.toBe('old');
    });
  },
);

describe.each([
  [
    'GlobalPresetService',
    'GLOBAL_PRESETS_FILE',
    'global_presets.json',
    'writeStoreOrThrow',
    'presets',
  ],
  [
    'ArtistLibraryService',
    'ARTIST_LIBRARY_FILE',
    'artist_library.json',
    'writeStoreOrThrow',
    'artists',
  ],
  [
    'ProjectTemplateService',
    'PROJECT_TEMPLATES_FILE',
    'project_templates.json',
    'save',
    'templates',
  ],
] as const)(
  '%s atomic manifest write',
  (className, constant, filename, method, key) => {
    test('a failed rename cannot fall back to overwriting the previous manifest', async () => {
      const write = jest.fn(async () => undefined);
      const backend = {
        writeFile: write,
        renameFile: jest.fn(async () => {
          throw new Error('rename denied');
        }),
      };
      const Subject = loadServiceMethods(
        path.resolve(__dirname, `../${className}.ts`),
        className,
        [method],
        {
          [constant]: filename,
          GLOBAL_PRESETS_VERSION: 2,
          persistService: new PersistenceService(),
        },
      );
      const service: any = Object.assign(new Subject(), {
        backend,
        services: { backend },
        [key]: [],
        tagPresets: [],
        loadGuard: { assertWritable: jest.fn() },
      });
      await expect(service[method]()).rejects.toThrow('rename denied');
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(`${filename}.tmp`, expect.any(String));
    });
  },
);
