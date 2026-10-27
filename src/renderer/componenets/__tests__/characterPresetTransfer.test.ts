import fs from 'fs';
import path from 'path';
import loadComponentFixture from '../testSupport/componentFixture';

const leaf = path.resolve(__dirname, '../../models/characterPresetTransfer.ts');
const legacy = path.resolve(__dirname, '../CharacterPresetEditor.tsx');
const basename = (value: unknown) =>
  String(value).replace(/\\/g, '/').split('/').pop() || '';
const safeToken = (value: unknown) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(value);

function fixture() {
  let sequence = 0;
  const files = new Map<string, string>([
    ['session/vibes/shared.png', 'existing'],
  ]);
  const pushMessage = jest.fn();
  const readDataFile = jest.fn(async (_imagePath: string) => 'image-data');
  const writeDataFile = jest.fn(async (imagePath: string, data: string) => {
    files.set(imagePath, data);
  });
  const deleteFile = jest.fn(async (imagePath: string) => {
    files.delete(imagePath);
  });
  const saveJsonFile = jest.fn(
    async (_filename: string, _data: string) => 'saved',
  );
  const session = {
    name: 'session',
    getCharacterPresets: jest.fn(),
    hasCharacterPreset: jest.fn(() => false),
    addCharacterPreset: jest.fn(),
  };
  const imageService = {
    getVibesDir: () => 'session/vibes',
    getReferenceDir: () => 'session/references',
    getVibeImagePath: (_owner: unknown, token: string) =>
      `session/vibes/${token}`,
    getReferenceImagePath: (_owner: unknown, token: string) =>
      `session/references/${token}`,
  };
  const backend = {
    readDataFile,
    writeDataFile,
    deleteFile,
    existFile: jest.fn(async (imagePath: string) => files.has(imagePath)),
  };
  const ports = {
    ...backend,
    ...imageService,
    saveJsonFile,
    pushMessage,
    stringifyExportJson: JSON.stringify,
    isSafeImageToken: safeToken,
    newImageName: () => `owned-${++sequence}.png`,
    presetFromJSON: (value: Record<string, unknown>) => ({ ...value }),
  };
  const bindings = {
    backend,
    imageService,
    saveJsonFile,
    appState: { pushMessage },
    stringifyExportJson: JSON.stringify,
    CharacterPreset: { fromJSON: ports.presetFromJSON },
    v4: () => `owned-${++sequence}`,
    imageFileExt: () => 'png',
    imageTokenBase: basename,
    isSafeImageToken: safeToken,
    safeImportedImageName: (
      value: unknown,
      validate: (input: unknown) => boolean,
      generate: () => string,
    ) =>
      validate(value)
        ? { name: value, renamed: false }
        : { name: generate(), renamed: true },
  };
  const transfer = fs.existsSync(leaf)
    ? jest.requireActual('../../models/characterPresetTransfer')
    : {
        exportCharacterPresets: loadComponentFixture(
          legacy,
          'exportCharacterPresets',
          bindings,
        ),
        importCharacterPresets: loadComponentFixture(
          legacy,
          'importCharacterPresets',
          bindings,
        ),
      };
  return {
    ...ports,
    files,
    session,
    exportPresets: () => transfer.exportCharacterPresets(session, ports),
    importPresets: (presets: unknown[]) =>
      transfer.importCharacterPresets(
        session,
        { text: async () => JSON.stringify({ version: 1, presets }) },
        ports,
      ),
    importBrokenFile: () =>
      transfer.importCharacterPresets(
        session,
        {
          text: async () => {
            throw new Error('cannot read input');
          },
        },
        ports,
      ),
  };
}

function preset(kind?: string) {
  const value = {
    name: 'sample',
    characterPrompt: '',
    characterUC: '',
    backgroundPrompt: '',
    vibes:
      kind === 'vibe' ? [{ path: 'shared.png', info: 1, strength: 1 }] : [],
    characterReferences:
      kind === 'reference'
        ? [
            {
              path: 'reference.png',
              info: 1,
              strength: 1,
              fidelity: 1,
              referenceType: 'character',
            },
          ]
        : [],
    representativeImage: kind === 'representative' ? 'representative.png' : '',
  };
  return { ...value, toJSON: () => JSON.parse(JSON.stringify(value)) };
}
function importRecord(kind: string) {
  const value: Record<string, unknown> = preset(kind).toJSON();
  if (kind === 'vibe')
    value.vibeImages = [{ filename: 'shared.png', data: 'new-image' }];
  if (kind === 'reference')
    value.referenceImages = [{ filename: 'reference.png', data: 'new-image' }];
  if (kind === 'representative') value.representativeImageData = 'new-image';
  return value;
}

test.each(['vibe', 'reference', 'representative'])(
  '%s export read failure does not save or report success',
  async (kind) => {
    const f = fixture();
    f.session.getCharacterPresets.mockReturnValue([preset(kind)]);
    f.readDataFile.mockRejectedValue(new Error('image unavailable'));
    await f.exportPresets();
    expect(f.saveJsonFile).not.toHaveBeenCalled();
    expect(
      f.pushMessage.mock.calls.some(([message]) =>
        message.includes('내보냈습니다'),
      ),
    ).toBe(false);
    expect(f.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('실패'),
      'error',
    );
  },
);

test.each(['vibe', 'reference', 'representative'])(
  '%s import write failure cannot publish a broken preset',
  async (kind) => {
    const f = fixture();
    f.writeDataFile.mockRejectedValue(new Error('disk unavailable'));
    await f.importPresets([importRecord(kind)]);
    expect(f.session.addCharacterPreset).not.toHaveBeenCalled();
    expect(
      f.pushMessage.mock.calls.some(([message]) =>
        message.includes('불러왔습니다'),
      ),
    ).toBe(false);
    expect(f.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('실패'),
      'error',
    );
  },
);

test('cancelled export does not report a completed export', async () => {
  const f = fixture();
  f.session.getCharacterPresets.mockReturnValue([preset()]);
  f.saveJsonFile.mockResolvedValue('cancelled');
  await f.exportPresets();
  expect(
    f.pushMessage.mock.calls.some(([message]) =>
      message.includes('내보냈습니다'),
    ),
  ).toBe(false);
});

test('failed file read is handled visibly before import', async () => {
  const f = fixture();
  await expect(f.importBrokenFile()).resolves.toBeUndefined();
  expect(f.session.addCharacterPreset).not.toHaveBeenCalled();
  expect(f.pushMessage).toHaveBeenCalledWith(
    expect.stringContaining('실패'),
    'error',
  );
});

test('import stores fresh owned tokens without overwriting an existing image', async () => {
  const f = fixture();
  await f.importPresets([importRecord('vibe')]);
  expect(f.files.get('session/vibes/shared.png')).toBe('existing');
  expect(f.session.addCharacterPreset).toHaveBeenCalledTimes(1);
  const imported = f.session.addCharacterPreset.mock.calls[0][0];
  expect(imported.vibes[0].path).not.toBe('shared.png');
  expect(f.files.get(`session/vibes/${imported.vibes[0].path}`)).toBe(
    'new-image',
  );
});

test('failed preset cleans only its own completed and partial image writes', async () => {
  const f = fixture();
  const item = importRecord('vibe');
  item.referenceImages = [
    { filename: 'reference.png', data: 'reference-data' },
  ];
  let writes = 0;
  f.writeDataFile.mockImplementation(async (imagePath, data) => {
    f.files.set(imagePath, data);
    if (++writes === 2) throw new Error('partial disk write');
  });
  await f.importPresets([item]);
  expect(f.session.addCharacterPreset).not.toHaveBeenCalled();
  expect(f.deleteFile).toHaveBeenCalledTimes(2);
  expect([...f.files.entries()]).toEqual([
    ['session/vibes/shared.png', 'existing'],
  ]);
});

test('a later failed preset preserves already completed entries and reports their count', async () => {
  const f = fixture();
  f.writeDataFile.mockRejectedValue(new Error('disk unavailable'));
  await f.importPresets([preset().toJSON(), importRecord('vibe')]);
  expect(f.session.addCharacterPreset).toHaveBeenCalledTimes(1);
  expect(f.pushMessage).toHaveBeenLastCalledWith(
    expect.stringContaining('1개 완료'),
    'error',
  );
});
