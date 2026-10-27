import path from 'path';
import { loadServiceMethods } from '../testSupport/completionMethodHarness';
import {
  isValidSession,
  isValidNAISPreset,
  isValidPieceLibrary,
} from '../types';

function shallowImportHarness(existing: string[] = []) {
  const loaded = new Set<string>();
  const files = new Map<string, string>();
  const backend = { writeDataFile: jest.fn(async () => undefined) };
  const Harness = loadServiceMethods(
    path.resolve(__dirname, '../SessionService.ts'),
    'SessionService',
    ['importSessionShallow', 'flushProjectNow'],
    {
      backend,
      projectPath: (...parts: string[]) => parts.join('/'),
      v4: () => 'fixture-profile',
      isWorkspaceLayout: () => false,
      persistService: { flushPath: jest.fn(async () => undefined) },
    },
  );
  const target = Object.assign(new Harness(), {
    isLoaded: (name: string) => loaded.has(name),
    list: () => existing,
    getPath: (name: string) => `projects/${name}.json`,
    createFrom: jest.fn(async (name: string) => {
      // The periodic sync catches disk failures and leaves a loaded dirty entry.
      loaded.add(name);
    }),
    writeResource: jest.fn(async (name: string) => {
      files.set(name, 'saved');
      return 'done';
    }),
  });
  return { target, backend, loaded, files };
}

describe('explicit legacy project import completion', () => {
  it('rejects a final disk failure and retains the loaded work for recovery', async () => {
    const { target, loaded, files } = shallowImportHarness();
    target.writeResource.mockRejectedValueOnce(new Error('disk is full'));
    await expect(
      target.importSessionShallow({ name: 'old', presets: {} }, 'New'),
    ).rejects.toThrow('disk is full');
    expect(loaded.has('New')).toBe(true);
    expect(files.has('New')).toBe(false);
  });

  it('does not report success when the storage guard defers the imported project', async () => {
    const { target } = shallowImportHarness();
    target.writeResource.mockResolvedValueOnce('retry');
    await expect(
      target.importSessionShallow({ name: 'old', presets: {} }, 'New'),
    ).rejects.toThrow('저장');
  });

  it('refuses an unloaded existing project before extracting any embedded profiles', async () => {
    const { target, backend } = shallowImportHarness(['Existing']);
    const source = {
      name: 'source',
      id: 'keep-source-id',
      presets: { style: [{ profile: 'embedded-image' }] },
    };
    await expect(
      target.importSessionShallow(source, 'Existing'),
    ).rejects.toThrow('이미');
    expect(source.name).toBe('source');
    expect(source.id).toBe('keep-source-id');
    expect(backend.writeDataFile).not.toHaveBeenCalled();
    expect(target.createFrom).not.toHaveBeenCalled();
  });
});

describe('malformed legacy file envelopes', () => {
  const valid = {
    name: 'old',
    presets: {},
    scenes: {},
    inpaints: {},
    library: {},
  };
  it.each(['presets', 'scenes', 'inpaints', 'library'])(
    'rejects null %s before import',
    (field) => {
      expect(isValidSession({ ...valid, [field]: null })).toBe(false);
    },
  );
  it('keeps legacy array presets but rejects array scene/library envelopes', () => {
    expect(isValidSession({ ...valid, presets: [] })).toBe(true);
    expect(isValidSession({ ...valid, scenes: [] })).toBe(false);
    expect(isValidSession({ ...valid, library: [] })).toBe(false);
  });
  it('accepts historical dictionary pieces as well as current array pieces', () => {
    expect(
      isValidPieceLibrary({
        description: 'legacy',
        pieces: { eyes: '' },
        multi: {},
      }),
    ).toBe(true);
    expect(
      isValidPieceLibrary({
        name: 'current',
        version: 1,
        pieces: [{ name: 'eyes', prompt: '' }],
      }),
    ).toBe(true);
    expect(isValidPieceLibrary({ description: 'bad', pieces: null })).toBe(
      false,
    );
  });
  it('treats null NAIS scenes as an unsupported file without throwing', () => {
    expect(isValidNAISPreset({ name: 'bad', scenes: [null] })).toBe(false);
  });
});
