/** @jest-environment jsdom */
import path from 'path';
import { loadServiceMethods } from '../testSupport/completionMethodHarness';

const noAction = (method: unknown) => method;

function characterFixture() {
  const original = {
    id: 'kept',
    name: 'Kept',
    updatedAt: 1,
    preset: { name: 'Kept', vibes: [], characterReferences: [] },
  };
  const Subject = loadServiceMethods(
    path.resolve(__dirname, '../GlobalCharacterPresetService.ts'),
    'GlobalCharacterPresetService',
    [
      'addFromSessionPreset',
      'instantiateIntoSession',
      'importFromFileData',
      'fileEntryName',
    ],
    {
      action: noAction,
      uuidv4: () => 'new-entry',
      CustomEvent,
      dataUriToBase64: (data: string) => data,
      CharacterPreset: {
        fromJSON: (json: unknown) => ({ toJSON: () => json }),
      },
      console: { warn: jest.fn(), error: jest.fn() },
    },
  );
  const backend = {
    readDataFile: jest.fn<Promise<string>, [string]>(async () => 'image-data'),
    deleteFile: jest.fn<Promise<void>, [string]>(async () => undefined),
  };
  const service: any = Object.assign(new Subject(), {
    backend,
    imageService: {
      getVibeImagePath: (_session: unknown, token: string) => `vibes/${token}`,
      getReferenceImagePath: (_session: unknown, token: string) =>
        `refs/${token}`,
      storeVibeImage: jest.fn(async () => 'local-new.png'),
      storeReferenceImage: jest.fn(async () => 'local-new-ref.png'),
    },
    presets: [original],
    folders: [],
    get: (id: string) => service.presets.find((entry: any) => entry.id === id),
    getByName: (name: string) =>
      service.presets.find((entry: any) => entry.name === name),
    resolveNameCollision: (name: string) => name,
    storeImageData: jest.fn<Promise<string>, [string]>(async () => 'new.png'),
    deleteImageData: jest.fn<Promise<void>, [string]>(async () => undefined),
    collectImageTokens: (preset: any) =>
      [
        ...(preset.vibes || []).map((item: any) => item.path),
        ...(preset.characterReferences || []).map((item: any) => item.path),
        preset.representativeImage,
      ].filter(Boolean),
    fetchImageData: jest.fn<Promise<string>, [string]>(
      async () => 'image-data',
    ),
    dispatchEvent: jest.fn(),
    scheduleSave: jest.fn(),
    flushSave: jest.fn(async () => undefined),
  });
  return { service, original, backend };
}

test('copying a local character preset to the library rejects missing source images before publishing an entry', async () => {
  const f = characterFixture();
  f.backend.readDataFile.mockRejectedValueOnce(new Error('source unreadable'));
  const preset = {
    toJSON: () => ({
      name: 'New',
      vibes: [{ path: 'source.png' }],
      characterReferences: [],
    }),
  };
  await expect(f.service.addFromSessionPreset({}, preset)).rejects.toThrow(
    'source unreadable',
  );
  expect(f.service.presets).toEqual([f.original]);
  expect(f.service.scheduleSave).not.toHaveBeenCalled();
});

test('a failed global image fetch cannot update the linked local character preset', async () => {
  const f = characterFixture();
  f.original.preset.vibes = [{ path: 'required.png' }] as never[];
  f.service.fetchImageData.mockRejectedValueOnce(
    new Error('global image unreadable'),
  );
  const existing = { name: 'Local', fromGlobalId: 'kept', fromGlobalRev: 0 };
  const session = {
    getCharacterPresets: () => [existing],
    addCharacterPreset: jest.fn(),
    updateCharacterPreset: jest.fn(),
  };
  await expect(
    f.service.instantiateIntoSession(session, 'kept'),
  ).rejects.toThrow('global image unreadable');
  expect(existing).toEqual({
    name: 'Local',
    fromGlobalId: 'kept',
    fromGlobalRev: 0,
  });
  expect(session.addCharacterPreset).not.toHaveBeenCalled();
  expect(session.updateCharacterPreset).not.toHaveBeenCalled();
});

test('a failed image save in an imported file rejects and cleans only this import image', async () => {
  const f = characterFixture();
  f.service.storeImageData
    .mockResolvedValueOnce('new.png')
    .mockRejectedValueOnce(new Error('image write denied'));
  await expect(
    f.service.importFromFileData({
      presets: [
        {
          name: 'New',
          vibes: [{ path: 'one.png' }, { path: 'two.png' }],
          characterReferences: [],
          vibeImages: [
            { filename: 'one.png', data: 'first' },
            { filename: 'two.png', data: 'second' },
          ],
        },
      ],
    }),
  ).rejects.toThrow('image write denied');
  expect(f.service.presets).toEqual([f.original]);
  expect(f.service.deleteImageData).toHaveBeenCalledWith('new.png');
  expect(f.service.deleteImageData).not.toHaveBeenCalledWith('required.png');
});

test('copying a local character preset into a template rejects before changing template contents', async () => {
  const entry = { characterPresets: [] };
  const Subject = loadServiceMethods(
    path.resolve(__dirname, '../ProjectTemplateService.ts'),
    'ProjectTemplateService',
    ['importSessionCharacterPreset'],
    { action: noAction },
  );
  const readDataFile = jest.fn(async () => {
    throw new Error('source unreadable');
  });
  const service: any = Object.assign(new Subject(), {
    get: () => entry,
    services: {
      backend: { readDataFile },
      imageService: {
        getVibeImagePath: (_session: unknown, token: string) => token,
      },
    },
    storeImageData: jest.fn(),
    deleteImageData: jest.fn(),
    charPresetNameCollision: (_entry: unknown, name: string) => name,
    touch: jest.fn(),
  });
  const preset = {
    toJSON: () => ({
      name: 'New',
      vibes: [{ path: 'source.png' }],
      characterReferences: [],
    }),
  };
  await expect(
    service.importSessionCharacterPreset('template', {}, preset),
  ).rejects.toThrow('source unreadable');
  expect(entry.characterPresets).toEqual([]);
  expect(service.touch).not.toHaveBeenCalled();
});
