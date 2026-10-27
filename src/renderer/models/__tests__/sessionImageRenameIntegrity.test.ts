import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ImageService } from '../ImageService';
import { backend } from '../index';
import { projectPath, PROJECT_IMAGE_ROOTS } from '../projectPaths';
import { setWorkspaceLayoutActive } from '../storageLayout';

jest.mock('../index', () => ({
  backend: {},
  isMobile: false,
  gameService: {},
  imageService: {},
  taskQueueService: {},
  trashService: {},
}));

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-project-rename-'));
  temporaryRoots.push(root);
  setWorkspaceLayoutActive(false);
  const absolute = (relative: string) => path.join(root, relative);
  const original = (kind: (typeof PROJECT_IMAGE_ROOTS)[number]) =>
    projectPath(kind, 'original');
  const renamed = (kind: (typeof PROJECT_IMAGE_ROOTS)[number]) =>
    projectPath(kind, 'renamed');
  const state: { denied?: string; renameFailure?: string } = {};
  const write = async (relative: string, bytes: string) => {
    await fs.mkdir(path.dirname(absolute(relative)), { recursive: true });
    await fs.writeFile(absolute(relative), bytes);
  };
  const checkAccess = (relative: string) => {
    if (relative === state.denied) {
      throw Object.assign(new Error('image folder denied'), { code: 'EACCES' });
    }
  };
  const io = {
    existFile: jest.fn(async (relative: string) => {
      checkAccess(relative);
      try {
        await fs.access(absolute(relative));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }),
    listFiles: jest.fn(async (relative: string) => {
      checkAccess(relative);
      try {
        return await fs.readdir(absolute(relative));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }),
    // Capacitor's actual rename rejects a missing source; real fs.rename has
    // that same contract, unlike the desktop adapter's absent-source no-op.
    renameDir: jest.fn(async (from: string, to: string) => {
      if (from === state.renameFailure) throw new Error('folder locked');
      await fs.mkdir(path.dirname(absolute(to)), { recursive: true });
      await fs.rename(absolute(from), absolute(to));
    }),
  };
  Object.assign(backend, io);
  return {
    absolute,
    original,
    renamed,
    write,
    state,
    io,
    images: new ImageService(),
  };
}

afterEach(async () => {
  setWorkspaceLayoutActive(false);
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  jest.restoreAllMocks();
});

describe('project image rename uses existence and error contracts', () => {
  test('a project with only one image root skips absent roots on Android', async () => {
    const f = await fixture();
    await f.write(`${f.original('outs')}/scene/image.png`, 'original image');

    await expect(
      f.images.onRenameSession('original', 'renamed'),
    ).resolves.toBeUndefined();

    expect(
      await fs.readFile(
        f.absolute(`${f.renamed('outs')}/scene/image.png`),
        'utf8',
      ),
    ).toBe('original image');
    expect(f.io.renameDir).toHaveBeenCalledTimes(1);
    expect(f.io.renameDir).toHaveBeenCalledWith(
      f.original('outs'),
      f.renamed('outs'),
    );
    await expect(
      fs.access(f.absolute(f.original('outs'))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an inaccessible root aborts before moving any readable root', async () => {
    const f = await fixture();
    for (const kind of PROJECT_IMAGE_ROOTS) {
      await f.write(`${f.original(kind)}/scene/image.png`, kind);
    }
    f.state.denied = f.original(PROJECT_IMAGE_ROOTS[1]);

    await expect(
      f.images.onRenameSession('original', 'renamed'),
    ).rejects.toMatchObject({ code: 'EACCES' });

    expect(f.io.renameDir).not.toHaveBeenCalled();
    for (const kind of PROJECT_IMAGE_ROOTS) {
      expect(
        await fs.readFile(
          f.absolute(`${f.original(kind)}/scene/image.png`),
          'utf8',
        ),
      ).toBe(kind);
    }
  });

  test('a later rename failure restores every earlier moved image root', async () => {
    const f = await fixture();
    for (const kind of PROJECT_IMAGE_ROOTS) {
      await f.write(`${f.original(kind)}/scene/image.png`, kind);
    }
    f.state.renameFailure = f.original(PROJECT_IMAGE_ROOTS[1]);

    await expect(
      f.images.onRenameSession('original', 'renamed'),
    ).rejects.toThrow('이동에 실패해 이름변경을 취소했습니다');

    expect(f.io.renameDir).toHaveBeenLastCalledWith(
      f.renamed(PROJECT_IMAGE_ROOTS[0]),
      f.original(PROJECT_IMAGE_ROOTS[0]),
    );
    for (const kind of PROJECT_IMAGE_ROOTS) {
      expect(
        await fs.readFile(
          f.absolute(`${f.original(kind)}/scene/image.png`),
          'utf8',
        ),
      ).toBe(kind);
      await expect(
        fs.access(f.absolute(f.renamed(kind))),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
