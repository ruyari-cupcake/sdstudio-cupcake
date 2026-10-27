/** @jest-environment jsdom */

const files: Record<string, string> = {};
let nextImage = 0;
const writeDataFile = jest.fn(async (path: string, data: string) => {
  files[path] = data;
});
const deleteFile = jest.fn(async (path: string) => {
  delete files[path];
});
const fetchImage = jest.fn(
  async (path: string): Promise<string | null> =>
    path in files ? `data:image/png;base64,${files[path]}` : null,
);
const storeVibeImage = jest.fn(async (_session: unknown, data: string) => {
  const filename = `migrated-${++nextImage}.png`;
  files[`vibes/Legacy/${filename}`] = data;
  return filename;
});

jest.mock('..', () => ({
  backend: { writeDataFile, deleteFile },
  imageService: {
    fetchImage,
    storeVibeImage,
    getVibesDir: () => 'vibes/Legacy',
    getVibeImagePath: (_session: unknown, name: string) =>
      `vibes/Legacy/${name}`,
  },
}));
jest.mock('../ImageService', () => ({
  dataUriToBase64: (data: string) => data.split(',').pop(),
}));
jest.mock('../AppService', () => ({ appState: { pushDialog: jest.fn() } }));
jest.mock('../appStateRef', () => ({
  getAppState: () => ({ pushDialog: jest.fn() }),
}));
jest.mock('../../defaultassets', () => []);

const { migrateSession } =
  jest.requireActual<typeof import('../legacy')>('../legacy');

function legacySession(embedded = false) {
  return {
    name: 'Legacy',
    presets: [],
    presetShareds: {},
    scenes: {},
    library: {},
    inpaints: {
      Inpaint: {
        name: 'Inpaint',
        resolution: 'portrait',
        prompt: 'kept prompt',
        uc: 'kept negative',
        imageMap: [],
        ...(embedded ? { image: 'SOURCE_IMAGE', mask: 'SOURCE_MASK' } : {}),
      },
    },
  };
}

function seedExistingImages() {
  files['inpaint_orgs/Legacy/Inpaint.png'] = 'SOURCE_IMAGE';
  files['inpaint_masks/Legacy/Inpaint.png'] = 'SOURCE_MASK';
}

beforeEach(() => {
  for (const path of Object.keys(files)) delete files[path];
  nextImage = 0;
  jest.clearAllMocks();
});

describe('legacy inpaint migration storage boundaries', () => {
  test.each(['inpaint_orgs', 'inpaint_masks'])(
    '%s write failure rejects and preserves embedded original data for retry',
    async (failingRoot) => {
      const session = legacySession(true);
      const original = JSON.parse(JSON.stringify(session));
      writeDataFile.mockImplementationOnce(async (path, data) => {
        if (path.startsWith(`${failingRoot}/`)) throw new Error('write denied');
        files[path] = data;
      });
      if (failingRoot === 'inpaint_masks') {
        writeDataFile.mockRejectedValueOnce(new Error('write denied'));
      }

      await expect(migrateSession(session)).rejects.toThrow('write denied');

      expect(session).toEqual(original);
      expect(deleteFile).not.toHaveBeenCalledWith(
        'inpaint_orgs/Legacy/Inpaint.png',
      );
      expect(deleteFile).not.toHaveBeenCalledWith(
        'inpaint_masks/Legacy/Inpaint.png',
      );
    },
  );

  it('read failure remains an error instead of committing an empty image path', async () => {
    seedExistingImages();
    const session = legacySession();
    const original = JSON.parse(JSON.stringify(session));
    fetchImage.mockRejectedValueOnce(new Error('read denied'));

    await expect(migrateSession(session)).rejects.toThrow('read denied');

    expect(session).toEqual(original);
    expect(storeVibeImage).not.toHaveBeenCalled();
    expect(files['inpaint_orgs/Legacy/Inpaint.png']).toBe('SOURCE_IMAGE');
  });

  it('second image store failure rejects and cleans only the new first copy', async () => {
    seedExistingImages();
    const session = legacySession();
    const original = JSON.parse(JSON.stringify(session));
    storeVibeImage
      .mockImplementationOnce(async (_session, data) => {
        files['vibes/Legacy/migrated-1.png'] = data;
        return 'migrated-1.png';
      })
      .mockRejectedValueOnce(new Error('store denied'));

    await expect(migrateSession(session)).rejects.toThrow('store denied');

    expect(session).toEqual(original);
    expect(deleteFile).toHaveBeenCalledWith('vibes/Legacy/migrated-1.png');
    expect(files['inpaint_orgs/Legacy/Inpaint.png']).toBe('SOURCE_IMAGE');
    expect(files['inpaint_masks/Legacy/Inpaint.png']).toBe('SOURCE_MASK');
  });

  it('confirmed missing optional assets stay empty without inventing stored paths', async () => {
    const session = legacySession();

    const migrated = await migrateSession(session);

    expect(migrated.inpaints.Inpaint.preset.image).toBe('');
    expect(migrated.inpaints.Inpaint.preset.mask).toBe('');
    expect(storeVibeImage).not.toHaveBeenCalled();
  });

  it('successful migration preserves original payload and returns both stored paths', async () => {
    const session = legacySession(true);
    const original = JSON.parse(JSON.stringify(session));

    const migrated = await migrateSession(session);

    expect(session).toEqual(original);
    expect(migrated.inpaints.Inpaint.preset.image).toBe('migrated-1.png');
    expect(migrated.inpaints.Inpaint.preset.mask).toBe('migrated-2.png');
    expect(files['vibes/Legacy/migrated-1.png']).toBe('SOURCE_IMAGE');
    expect(files['vibes/Legacy/migrated-2.png']).toBe('SOURCE_MASK');
  });
});
