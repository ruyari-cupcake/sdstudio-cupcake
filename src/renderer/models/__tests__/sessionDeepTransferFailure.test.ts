/** @jest-environment node */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PersistenceService } from '../PersistenceService';
import {
  PROJECT_IMAGE_ROOTS,
  projectJsonPath,
  projectPath,
  workspacePath,
} from '../projectPaths';
import {
  isWorkspaceLayout,
  physicalDirOf,
  registerProjectDir,
  setWorkspaceLayoutActive,
  unregisterProjectDir,
} from '../storageLayout';
import {
  deferred,
  loadServiceMethods,
} from '../testSupport/completionMethodHarness';

type Transfer = 'import' | 'duplicate';
type Layout = 'legacy' | 'workspace';

const temporaryRoots: string[] = [];
const sourceSnapshot = {
  name: 'source',
  id: 'original-id',
  version: 1,
  presets: {},
  scenes: {},
  inpaints: {},
  library: {},
  presetShareds: {},
};
const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 21, 34, 55]);

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function makeFixture(transfer: Transfer, layout: Layout) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-deep-transfer-'));
  temporaryRoots.push(root);
  setWorkspaceLayoutActive(layout === 'workspace');
  if (layout === 'workspace') registerProjectDir('source', 'source-original');
  const absolute = (relative: string) => path.join(root, relative);
  const write = async (relative: string, data: string | Buffer) => {
    await fs.mkdir(path.dirname(absolute(relative)), { recursive: true });
    await fs.writeFile(
      absolute(relative),
      typeof data === 'string' ? data : new Uint8Array(data),
    );
  };
  const sourceDir = (imageRoot: (typeof PROJECT_IMAGE_ROOTS)[number]) =>
    transfer === 'import'
      ? `archive/${imageRoot}`
      : projectPath(imageRoot, 'source');
  const sourceJson =
    transfer === 'import' ? 'archive/project.json' : projectJsonPath('source');
  await write(sourceJson, JSON.stringify(sourceSnapshot));
  await write(`${sourceDir('outs')}/image.png`, imageBytes);
  await write(`${sourceDir('inpaints')}/kept.png`, imageBytes);

  const state: { deniedPath?: string; failure?: Error } = {};
  const backend = {
    listFiles: jest.fn(async (relative: string) => {
      if (relative === state.deniedPath) throw state.failure;
      try {
        return await fs.readdir(absolute(relative));
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    }),
    listFilesWithStats: jest.fn(async (relative: string) => {
      const entries = await fs.readdir(absolute(relative), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => ({ name: entry.name }));
    }),
    readFile: jest.fn((relative: string) =>
      fs.readFile(absolute(relative), 'utf8'),
    ),
    copyFile: jest.fn(async (from: string, to: string) => {
      await fs.mkdir(path.dirname(absolute(to)), { recursive: true });
      await fs.copyFile(absolute(from), absolute(to));
    }),
    deleteDir: jest.fn((relative: string) =>
      fs.rm(absolute(relative), { recursive: true, force: true }),
    ),
  };
  const Service = loadServiceMethods(
    path.join(__dirname, '..', 'SessionService.ts'),
    'SessionService',
    ['importSessionDeepFromDir', 'duplicateSessionDeep', 'copyDirRecursive'],
    {
      backend,
      PROJECT_IMAGE_ROOTS,
      projectPath,
      workspacePath,
      isWorkspaceLayout,
      physicalDirOf,
      unregisterProjectDir,
      v4: () => 'copied-id',
    },
  );
  const service = new Service();
  service.folderMap = {};
  service.isLoaded = jest.fn().mockReturnValue(false);
  service.list = jest.fn().mockReturnValue(['source']);
  service.getFolderOf = jest.fn().mockReturnValue(null);
  service.ensureWorkspaceProject = jest.fn(async (name: string) => {
    registerProjectDir(name, 'target-copied');
    await write(
      workspacePath('target-copied', 'meta.json'),
      JSON.stringify({ name, id: 'copied-id' }),
    );
    return 'target-copied';
  });
  service.createFrom = jest.fn(async (name: string, json: unknown) => {
    await write(projectJsonPath(name), JSON.stringify(json));
  });
  const source = {
    name: 'source',
    toJSON: () => JSON.parse(JSON.stringify(sourceSnapshot)),
  };
  const run = () =>
    transfer === 'import'
      ? service.importSessionDeepFromDir('archive', 'target')
      : service.duplicateSessionDeep(source, 'target');
  return {
    root,
    absolute,
    write,
    sourceDir,
    sourceJson,
    state,
    backend,
    service,
    run,
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

describe('deep project transfers preserve source access failures', () => {
  const cases: [Transfer, Layout][] = [
    ['import', 'legacy'],
    ['duplicate', 'legacy'],
    ['import', 'workspace'],
    ['duplicate', 'workspace'],
  ];

  test.each(cases)(
    '%s rejects an unreadable image root in %s storage',
    async (transfer, layout) => {
      const fixture = await makeFixture(transfer, layout);
      const failure = Object.assign(
        new Error('source image directory access denied'),
        { code: 'EACCES' },
      );
      fixture.state.deniedPath = fixture.sourceDir('inpaints');
      fixture.state.failure = failure;
      const beforeJson = await fs.readFile(
        fixture.absolute(fixture.sourceJson),
        'utf8',
      );
      const beforeImage = await fs.readFile(
        fixture.absolute(`${fixture.sourceDir('inpaints')}/kept.png`),
      );

      await expect(fixture.run()).rejects.toBe(failure);

      // A preceding root really copied before the later source root failed.
      expect(fixture.backend.copyFile).toHaveBeenCalledWith(
        `${fixture.sourceDir('outs')}/image.png`,
        layout === 'workspace'
          ? 'workspace/target-copied/outs/image.png'
          : 'outs/target/image.png',
      );
      expect(fixture.service.createFrom).not.toHaveBeenCalled();
      expect(
        await fs.readFile(fixture.absolute(fixture.sourceJson), 'utf8'),
      ).toBe(beforeJson);
      expect(
        await fs.readFile(
          fixture.absolute(`${fixture.sourceDir('inpaints')}/kept.png`),
        ),
      ).toEqual(beforeImage);
      const targetJson =
        layout === 'workspace'
          ? 'workspace/target-copied/project.json'
          : 'projects/target.json';
      await expect(
        fs.access(fixture.absolute(targetJson)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(physicalDirOf('target')).toBeUndefined();
    },
  );

  test.each(['import', 'duplicate'] as Transfer[])(
    '%s allows absent optional image roots',
    async (transfer) => {
      const fixture = await makeFixture(transfer, 'legacy');
      await fs.rm(fixture.absolute(fixture.sourceDir('inpaints')), {
        recursive: true,
      });
      await fixture.run();

      expect(fixture.service.createFrom).toHaveBeenCalledTimes(1);
      const restored = JSON.parse(
        await fs.readFile(fixture.absolute('projects/target.json'), 'utf8'),
      );
      expect(restored.name).toBe('target');
      expect(
        await fs.readFile(fixture.absolute('outs/target/image.png')),
      ).toEqual(imageBytes);
      expect(
        await fs.readFile(
          fixture.absolute(`${fixture.sourceDir('outs')}/image.png`),
        ),
      ).toEqual(imageBytes);
    },
  );
});

test('draining a path waits for settlement while the owned write promise reports failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sd-write-receipt-'));
  temporaryRoots.push(root);
  const file = path.join(root, 'project.json');
  await fs.writeFile(file, 'previous snapshot');
  const writerGate = deferred<void>();
  const failure = new Error('write denied');
  const persistence = new PersistenceService();
  const write = persistence.writeWith(
    file,
    'latest snapshot',
    async (snapshot) => {
      await writerGate.promise;
      await fs.writeFile(file, snapshot);
    },
  );
  // Observe rejection before releasing the writer; the acknowledgement belongs
  // to this write promise, while flushPath only represents queue settlement.
  const writeOutcome = write.then(
    () => ({ kind: 'saved' as const }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );
  let drained = false;
  const drain = persistence.flushPath(file).then(() => {
    drained = true;
    return undefined;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  writerGate.reject(failure);
  await expect(writeOutcome).resolves.toEqual({
    kind: 'failed',
    error: failure,
  });
  await drain;

  expect(drained).toBe(true);
  expect(await fs.readFile(file, 'utf8')).toBe('previous snapshot');
});
