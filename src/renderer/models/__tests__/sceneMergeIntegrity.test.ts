import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { runInThisContext } from 'vm';
import ts from 'typescript';
import { ImageService } from '../ImageService';
import { backend } from '../index';
import { projectPath, PROJECT_SCENE_IMAGE_ROOTS } from '../projectPaths';
import { setWorkspaceLayoutActive, registerProjectDir } from '../storageLayout';
import type { Scene, Session } from '../types';

jest.mock('../index', () => ({
  backend: {},
  isMobile: false,
  gameService: {},
  imageService: {},
  taskQueueService: {},
  trashService: {},
}));

const temporaryRoots: string[] = [];
type Merge = (
  session: Session,
  source: string,
  target: string,
) => Promise<void>;

/** Run the actual exported orchestration without starting the application graph. */
function loadMerge(
  imageService: ImageService,
  sessionService: object,
  tasks: object,
): Merge {
  const filename = path.join(__dirname, '..', 'SessionService.ts');
  const source = ts.createSourceFile(
    filename,
    fsSync.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) => item.name.getText(source) === 'mergeScene',
      ),
  );
  if (!declaration) throw new Error('Missing production mergeScene export');
  const compiled = ts.transpileModule(declaration.getText(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const factory = runInThisContext(
    `(function(imageService, sessionService, taskQueueService) { const exports = {}; ${compiled}; return exports.mergeScene; })`,
    { filename },
  ) as (images: ImageService, sessions: object, tasks: object) => Merge;
  return factory(imageService, sessionService, tasks);
}

async function fixture(workspace = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-scene-merge-'));
  temporaryRoots.push(root);
  setWorkspaceLayoutActive(workspace);
  if (workspace) registerProjectDir('project', 'project-id');
  const absolute = (relative: string) => path.join(root, relative);
  const write = async (relative: string, bytes: string) => {
    await fs.mkdir(path.dirname(absolute(relative)), { recursive: true });
    await fs.writeFile(absolute(relative), bytes);
  };
  const source = {
    name: 'source',
    type: 'scene',
    mains: [],
  } as unknown as Scene;
  const target = {
    name: 'target',
    type: 'scene',
    mains: [],
  } as unknown as Scene;
  const session = {
    name: 'project',
    scenes: new Map([
      ['source', source],
      ['target', target],
    ]),
  } as unknown as Session;
  const sourceDir = (kind: (typeof PROJECT_SCENE_IMAGE_ROOTS)[number]) =>
    projectPath(kind, session.name, source.name);
  const targetDir = (kind: (typeof PROJECT_SCENE_IMAGE_ROOTS)[number]) =>
    projectPath(kind, session.name, target.name);
  const state: {
    copyFailure?: string;
    listFailure?: string;
    deleteFailure?: string;
  } = {};
  const io = {
    listFiles: jest.fn(async (relative: string) => {
      if (state.listFailure === relative) {
        throw Object.assign(new Error('directory denied'), { code: 'EACCES' });
      }
      try {
        return await fs.readdir(absolute(relative));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    }),
    copyFile: jest.fn(async (from: string, to: string) => {
      await fs.mkdir(path.dirname(absolute(to)), { recursive: true });
      if (state.copyFailure === from) {
        // Real file APIs can leave a partial destination before reporting failure.
        await fs.writeFile(absolute(to), 'partial');
        throw Object.assign(new Error('copy failed'), { code: 'EIO' });
      }
      await fs.copyFile(absolute(from), absolute(to));
    }),
    deleteFile: jest.fn(async (relative: string) => {
      if (state.deleteFailure === relative) throw new Error('source locked');
      await fs.unlink(absolute(relative));
    }),
    // Match the actual desktop contract: this is recursive, never "empty only".
    deleteDir: jest.fn((relative: string) =>
      fs.rm(absolute(relative), { recursive: true, force: true }),
    ),
  };
  Object.assign(backend, io);
  const images = new ImageService();
  images.refresh = jest.fn(async () => 'files' as const);
  let locked = false;
  const sessions = {
    guardCrossWindowLock: jest.fn(async () => true),
    withLock: jest.fn(async (_names: string[], run: () => Promise<void>) => {
      locked = true;
      try {
        await run();
      } finally {
        locked = false;
      }
    }),
  };
  const tasks = {
    hasPendingExecution: jest.fn(() => false),
    isEmpty: jest.fn(() => true),
  };
  return {
    root,
    absolute,
    write,
    source,
    target,
    session,
    sourceDir,
    targetDir,
    state,
    io,
    images,
    sessions,
    tasks,
    isLocked: () => locked,
    merge: loadMerge(images, sessions, tasks),
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

describe('scene merges preserve real files and publish only complete transfers', () => {
  test.each([false, true])(
    'a late copy error preserves originals and the source scene (workspace=%s)',
    async (workspace) => {
      const f = await fixture(workspace);
      await f.write(`${f.sourceDir('outs')}/a.png`, 'original A');
      await f.write(`${f.sourceDir('outs')}/b.png`, 'original B');
      await f.write(`${f.targetDir('outs')}/a.png`, 'existing target');
      f.state.copyFailure = `${f.sourceDir('outs')}/b.png`;

      const outcome = await f.merge(f.session, 'source', 'target').then(
        () => ({ ok: true, error: null }),
        (error: unknown) => ({ ok: false, error }),
      );

      expect(
        await fs.readFile(f.absolute(`${f.sourceDir('outs')}/a.png`), 'utf8'),
      ).toBe('original A');
      expect(
        await fs.readFile(f.absolute(`${f.sourceDir('outs')}/b.png`), 'utf8'),
      ).toBe('original B');
      expect(f.session.scenes.get('source')).toBe(f.source);
      expect(outcome.ok).toBe(false);
      expect(f.io.deleteDir).not.toHaveBeenCalled();
      expect(await fs.readdir(f.absolute(f.targetDir('outs')))).toEqual([
        'a.png',
      ]);
      expect(
        await fs.readFile(f.absolute(`${f.targetDir('outs')}/a.png`), 'utf8'),
      ).toBe('existing target');
    },
  );

  test('an unreadable source root is not treated as an empty scene', async () => {
    const f = await fixture();
    await f.write(`${f.sourceDir('outs')}/a.png`, 'preserve me');
    f.state.listFailure = f.sourceDir('outs');

    await expect(f.merge(f.session, 'source', 'target')).rejects.toMatchObject({
      code: 'EACCES',
    });

    expect(f.session.scenes.get('source')).toBe(f.source);
    expect(
      await fs.readFile(f.absolute(`${f.sourceDir('outs')}/a.png`), 'utf8'),
    ).toBe('preserve me');
    expect(f.io.copyFile).not.toHaveBeenCalled();
    expect(f.io.deleteDir).not.toHaveBeenCalled();
  });

  test('a target listing error cannot overwrite an existing target image', async () => {
    const f = await fixture();
    await f.write(`${f.sourceDir('outs')}/a.png`, 'source bytes');
    await f.write(`${f.targetDir('outs')}/a.png`, 'target bytes');
    f.state.listFailure = f.targetDir('outs');

    await expect(f.merge(f.session, 'source', 'target')).rejects.toMatchObject({
      code: 'EACCES',
    });

    expect(
      await fs.readFile(f.absolute(`${f.targetDir('outs')}/a.png`), 'utf8'),
    ).toBe('target bytes');
    expect(
      await fs.readFile(f.absolute(`${f.sourceDir('outs')}/a.png`), 'utf8'),
    ).toBe('source bytes');
    expect(f.session.scenes.has('source')).toBe(true);
  });

  test('successful collision handling keeps unrelated source content and clears only its image cache', async () => {
    const f = await fixture(true);
    await f.write(`${f.sourceDir('outs')}/a.png`, 'source bytes');
    await f.write(`${f.targetDir('outs')}/a.png`, 'target bytes');
    await f.write(`${f.sourceDir('outs')}/notes.txt`, 'do not delete');
    await f.write(`${f.sourceDir('outs')}/nested/other.png`, 'nested original');
    f.images.cache.set(`${f.sourceDir('outs')}/a.png`, 'cached source');
    f.images.cache.set(`${f.sourceDir('outs')}-other/a.png`, 'other scene');
    let copiedUnderLock = false;
    const copy = f.io.copyFile.getMockImplementation()!;
    f.io.copyFile.mockImplementation(async (from, to) => {
      copiedUnderLock = f.isLocked();
      await copy(from, to);
    });

    await f.merge(f.session, 'source', 'target');

    expect(copiedUnderLock).toBe(true);
    expect(f.sessions.guardCrossWindowLock).toHaveBeenCalledWith(
      'project',
      '씬 병합',
    );
    expect(f.session.scenes.has('source')).toBe(false);
    expect(f.session.scenes.get('target')).toBe(f.target);
    expect(
      await fs.readFile(f.absolute(`${f.targetDir('outs')}/a.png`), 'utf8'),
    ).toBe('target bytes');
    expect(
      await fs.readFile(
        f.absolute(`${f.targetDir('outs')}/a_merged1.png`),
        'utf8',
      ),
    ).toBe('source bytes');
    await expect(
      fs.access(f.absolute(`${f.sourceDir('outs')}/a.png`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await fs.readFile(f.absolute(`${f.sourceDir('outs')}/notes.txt`), 'utf8'),
    ).toBe('do not delete');
    expect(
      await fs.readFile(
        f.absolute(`${f.sourceDir('outs')}/nested/other.png`),
        'utf8',
      ),
    ).toBe('nested original');
    expect(f.images.cache.get(`${f.sourceDir('outs')}/a.png`)).toBeNull();
    expect(f.images.cache.get(`${f.sourceDir('outs')}-other/a.png`)).toBe(
      'other scene',
    );
    expect(f.images.refresh).toHaveBeenCalledWith(f.session, f.target);
  });

  test('source unlink failure does not report a completed merge or remove the source scene', async () => {
    const f = await fixture();
    await f.write(`${f.sourceDir('outs')}/a.png`, 'original');
    f.state.deleteFailure = `${f.sourceDir('outs')}/a.png`;

    await expect(f.merge(f.session, 'source', 'target')).rejects.toThrow(
      'source locked',
    );

    expect(f.session.scenes.get('source')).toBe(f.source);
    expect(
      await fs.readFile(f.absolute(`${f.sourceDir('outs')}/a.png`), 'utf8'),
    ).toBe('original');
    expect(
      await fs.readFile(f.absolute(`${f.targetDir('outs')}/a.png`), 'utf8'),
    ).toBe('original');
    expect(f.io.deleteDir).not.toHaveBeenCalled();
  });

  test.each([
    { pendingExecution: true, empty: true },
    { pendingExecution: false, empty: false },
  ])(
    'unsettled or queued generation cannot lose its source scene: %j',
    async (state) => {
      const f = await fixture();
      await f.write(`${f.sourceDir('outs')}/a.png`, 'previous output');
      f.tasks.hasPendingExecution.mockReturnValue(state.pendingExecution);
      f.tasks.isEmpty.mockReturnValue(state.empty);

      await expect(f.merge(f.session, 'source', 'target')).rejects.toThrow(
        '생성',
      );

      expect(f.session.scenes.get('source')).toBe(f.source);
      expect(f.io.listFiles).not.toHaveBeenCalled();
      expect(f.io.copyFile).not.toHaveBeenCalled();
      expect(
        await fs.readFile(f.absolute(`${f.sourceDir('outs')}/a.png`), 'utf8'),
      ).toBe('previous output');
    },
  );

  test('generation admitted during the window-ownership check also blocks merging', async () => {
    const f = await fixture();
    f.sessions.guardCrossWindowLock.mockImplementation(async () => {
      f.tasks.hasPendingExecution.mockReturnValue(true);
      return true;
    });

    await expect(f.merge(f.session, 'source', 'target')).rejects.toThrow(
      '생성',
    );

    expect(f.session.scenes.get('source')).toBe(f.source);
    expect(f.io.listFiles).not.toHaveBeenCalled();
  });

  test('another window owning the project prevents all merge IO', async () => {
    const f = await fixture();
    f.sessions.guardCrossWindowLock.mockResolvedValue(false);

    await expect(f.merge(f.session, 'source', 'target')).rejects.toThrow();

    expect(f.session.scenes.get('source')).toBe(f.source);
    expect(f.io.listFiles).not.toHaveBeenCalled();
    expect(f.io.copyFile).not.toHaveBeenCalled();
    expect(f.images.refresh).not.toHaveBeenCalled();
  });
});
