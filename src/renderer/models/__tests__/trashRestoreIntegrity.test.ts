import { promises as fs, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import { TrashService, type TrashServiceDependencies } from '../TrashService';
import { persistService } from '../PersistenceService';
import { setWorkspaceLayoutActive } from '../storageLayout';
import type { GenericScene, Session } from '../types';
import PreviewReadScope from '../../componenets/PreviewReadScope';

type TrashEntry = {
  filename: string;
  deletedAt: number;
  thumbnail?: string | null;
};
type ReviewEntry = { scene: GenericScene; filename: string; path: string };

function state<T>(initial: T) {
  let value = initial;
  return {
    get: () => value,
    set: (next: T | ((previous: T) => T)) => {
      value =
        typeof next === 'function' ? (next as (previous: T) => T)(value) : next;
    },
  };
}

function componentSource(file: string, component: string) {
  const filename = path.resolve(__dirname, '../../componenets', file);
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const owner = source.statements.find((statement) => {
    if (ts.isFunctionDeclaration(statement))
      return statement.name?.text === component;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === component,
      );
    }
    return false;
  });
  if (!owner) throw new Error(`Missing production component ${component}`);
  return { source, owner };
}

// Run the actual caller and its actual list-refresh function, without booting
// app singletons. The injected TrashService still performs every file operation.
function loadCaller<T>(
  file: string,
  component: string,
  name: string,
  bindings: Record<string, unknown>,
): T {
  const { source, owner } = componentSource(file, component);
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      declaration = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(owner);
  if (!declaration) throw new Error(`Missing production caller ${name}`);
  const compiled = ts.transpileModule(
    `const ${declaration.getText(source)}; ${name};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  return new vm.Script(compiled).runInNewContext({ console, ...bindings }) as T;
}

function loadReviewRestoreClick(
  bindings: Record<string, unknown>,
): () => Promise<void> {
  const { source, owner } = componentSource('ImageReview.tsx', 'ImageReview');
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'onClick' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression?.getText(source).includes('restoreTrashItem')
    )
      expression = node.initializer.expression;
    ts.forEachChild(node, visit);
  };
  visit(owner);
  if (!expression)
    throw new Error('Missing production review restore click handler');
  const compiled = ts.transpileModule(
    `const click = ${expression.getText(source)}; click;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  return new vm.Script(compiled).runInNewContext({ console, ...bindings });
}

async function createFixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cupcake-restore-integrity-'),
  );
  const resolve = (relative: string) => {
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`))
      throw new Error('Fixture path escaped its root');
    return absolute;
  };
  const backend = {
    existFile: async (relative: string) => {
      try {
        await fs.stat(resolve(relative));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    },
    readFile: (relative: string) => fs.readFile(resolve(relative), 'utf8'),
    writeFile: async (relative: string, content: string) => {
      await fs.mkdir(path.dirname(resolve(relative)), { recursive: true });
      await fs.writeFile(resolve(relative), content);
    },
    renameFile: async (from: string, to: string) => {
      await fs.mkdir(path.dirname(resolve(to)), { recursive: true });
      await fs.rename(resolve(from), resolve(to));
    },
    listFiles: (relative: string) => fs.readdir(resolve(relative)),
  };
  const session = { name: 'project' } as Session;
  const scene = { name: 'scene', type: 'scene' } as GenericScene;
  const outputDir = 'outs/project/scene';
  const trashDir = `${outputDir}/.trash`;
  const metadata = `${trashDir}/.trash_meta.json`;
  const imageService = {
    invalidateCacheBatch: jest.fn(async (_paths: string[]) => {}),
    refresh: jest.fn(async () => {}),
    getOutputDir: () => outputDir,
    fetchImageSmall: jest.fn(async () => null),
  };
  const service = new TrashService({
    backend: backend as unknown as TrashServiceDependencies['backend'],
    templateService: { removeProject: jest.fn() },
    sessionService: { guardCrossWindowLock: jest.fn() },
    imageService,
  });
  const initialMeta = { 'good.png': 11, 'blocked.webp': 22 };
  await backend.writeFile(`${trashDir}/good.png`, 'original good image bytes');
  await backend.writeFile(
    `${trashDir}/blocked.webp`,
    'original blocked image bytes',
  );
  await backend.writeFile(metadata, JSON.stringify(initialMeta));
  // A real incompatible destination makes fs.rename fail on the host OS. No
  // service or rename error is mocked, and the existing destination must survive.
  await fs.mkdir(resolve(`${outputDir}/blocked.webp`));
  await fs.writeFile(
    resolve(`${outputDir}/blocked.webp/preserved.txt`),
    'existing destination',
  );
  return {
    root,
    resolve,
    backend,
    session,
    scene,
    outputDir,
    trashDir,
    metadata,
    initialMeta,
    imageService,
    service,
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

function galleryCaller(fixture: Fixture, filenames: string[]) {
  const selected = state(new Set(filenames));
  const trashImages = state<TrashEntry[]>([]);
  const appState = { pushMessage: jest.fn() };
  const scope = new PreviewReadScope();
  const bindings = {
    session: fixture.session,
    scene: fixture.scene,
    trashService: fixture.service,
    imageService: fixture.imageService,
    appState,
    useCallback: (callback: unknown) => callback,
    setLoading: jest.fn(),
    setTrashImages: trashImages.set,
    setSelected: selected.set,
    selected: selected.get(),
    withPreviewPause: (operation: () => Promise<void>) =>
      scope.whilePaused(operation),
  };
  const refresh = loadCaller<() => Promise<void>>(
    'ResultViewer.tsx',
    'TrashImageView',
    'refresh',
    bindings,
  );
  const restore = loadCaller<() => Promise<void>>(
    'ResultViewer.tsx',
    'TrashImageView',
    'handleRestore',
    { ...bindings, refresh },
  );
  return { selected, trashImages, appState, refresh, restore };
}

function reviewCaller(fixture: Fixture) {
  const previewScope = new PreviewReadScope();
  const items = state<ReviewEntry[]>([]);
  const trashItems = state<TrashEntry[]>([]);
  const appState = { pushMessage: jest.fn() };
  const bindings = {
    session: fixture.session,
    trashScene: fixture.scene,
    trashService: fixture.service,
    imageService: fixture.imageService,
    appState,
    index: 0,
    isMobile: false,
    withPreviewPause: (operation: () => Promise<void>) =>
      previewScope.whilePaused(operation),
    useCallback: (callback: unknown) => callback,
    setTrashScene: jest.fn(),
    setTrashLoading: jest.fn(),
    setTrashItems: trashItems.set,
    setItems: items.set,
  };
  const loadTrash = loadCaller<(scene: GenericScene) => Promise<void>>(
    'ImageReview.tsx',
    'ImageReview',
    'loadTrash',
    bindings,
  );
  const restoreTrashItem = loadCaller<(entry: TrashEntry) => Promise<void>>(
    'ImageReview.tsx',
    'ImageReview',
    'restoreTrashItem',
    { ...bindings, loadTrash },
  );
  return {
    items,
    trashItems,
    appState,
    loadTrash,
    restoreTrashItem,
    click: (entry: TrashEntry) =>
      loadReviewRestoreClick({ appState, restoreTrashItem, entry }),
  };
}

describe('trash restore outcomes with actual service, callers and filesystem', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    setWorkspaceLayoutActive(false);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    fixture = await createFixture();
  });

  afterEach(async () => {
    await persistService.flushAll();
    await fs.rm(fixture.root, { recursive: true, force: true });
    jest.restoreAllMocks();
    setWorkspaceLayoutActive(false);
  });

  test('returns the real failure count, preserves failed bytes and metadata, then allows retry', async () => {
    const updated = jest.fn();
    fixture.service.addEventListener('trash-updated', updated);
    const failed = await fixture.service.restoreImages(
      fixture.session,
      fixture.scene,
      ['good.png', 'blocked.webp'],
    );
    expect(
      await fixture.backend.readFile(`${fixture.outputDir}/good.png`),
    ).toBe('original good image bytes');
    expect(
      await fixture.backend.existFile(`${fixture.trashDir}/good.png`),
    ).toBe(false);
    expect(
      await fixture.backend.readFile(`${fixture.trashDir}/blocked.webp`),
    ).toBe('original blocked image bytes');
    expect(
      await fixture.backend.readFile(
        `${fixture.outputDir}/blocked.webp/preserved.txt`,
      ),
    ).toBe('existing destination');
    expect(
      JSON.parse(await fixture.backend.readFile(fixture.metadata)),
    ).toEqual({ 'blocked.webp': 22 });
    expect(fixture.imageService.invalidateCacheBatch).toHaveBeenLastCalledWith([
      `${fixture.trashDir}/good.png`,
    ]);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(failed).toBe(1);
    await fs.rm(fixture.resolve(`${fixture.outputDir}/blocked.webp`), {
      recursive: true,
    });
    expect(
      await fixture.service.restoreImages(fixture.session, fixture.scene, [
        'blocked.webp',
      ]),
    ).toBe(0);
    expect(
      await fixture.backend.readFile(`${fixture.outputDir}/blocked.webp`),
    ).toBe('original blocked image bytes');
    expect(
      JSON.parse(await fixture.backend.readFile(fixture.metadata)),
    ).toEqual({});
  });

  test('keeps hard metadata errors rejected before any image move', async () => {
    await fixture.backend.writeFile(fixture.metadata, '{broken');
    await expect(
      fixture.service.restoreImages(fixture.session, fixture.scene, [
        'good.png',
      ]),
    ).rejects.toThrow();
    expect(await fixture.backend.readFile(`${fixture.trashDir}/good.png`)).toBe(
      'original good image bytes',
    );
    expect(
      await fixture.backend.existFile(`${fixture.outputDir}/good.png`),
    ).toBe(false);
    expect(await fixture.backend.readFile(fixture.metadata)).toBe('{broken');
    expect(fixture.imageService.invalidateCacheBatch).not.toHaveBeenCalled();
  });

  test.each([
    { filenames: ['good.png', 'blocked.webp'], restored: 1 },
    { filenames: ['blocked.webp'], restored: 0 },
  ])(
    'gallery reports $restored successes and one failure from selected files',
    async ({ filenames, restored }) => {
      const caller = galleryCaller(fixture, filenames);
      await caller.refresh();
      await caller.restore();
      expect(caller.appState.pushMessage).toHaveBeenCalledWith(
        `${restored}장의 이미지가 복원되었고, 1장은 복원하지 못했습니다. 잠시 후 다시 시도해주세요.`,
      );
      expect(caller.appState.pushMessage).not.toHaveBeenCalledWith(
        `${filenames.length}장의 이미지가 복원되었습니다.`,
      );
      expect(fixture.imageService.refresh).toHaveBeenCalledWith(
        fixture.session,
        fixture.scene,
      );
      expect(Array.from(caller.selected.get())).toEqual(['blocked.webp']);
      expect(
        caller.trashImages
          .get()
          .map((entry) => entry.filename)
          .sort(),
      ).toEqual(restored ? ['blocked.webp'] : ['blocked.webp', 'good.png']);
      expect(
        await fixture.backend.readFile(`${fixture.trashDir}/blocked.webp`),
      ).toBe('original blocked image bytes');
    },
  );

  test('single review restore retains a failed entry and never adds a nonexistent reviewed image', async () => {
    const caller = reviewCaller(fixture);
    await caller.loadTrash(fixture.scene);
    await caller.restoreTrashItem({ filename: 'blocked.webp', deletedAt: 22 });
    expect(caller.appState.pushMessage).toHaveBeenCalledWith(
      'blocked.webp 파일을 복원하지 못했습니다. 잠시 후 다시 시도해주세요.',
    );
    expect(caller.appState.pushMessage).not.toHaveBeenCalledWith(
      'blocked.webp 복원 완료',
    );
    expect(caller.items.get()).toEqual([]);
    expect(caller.trashItems.get().map((entry) => entry.filename)).toContain(
      'blocked.webp',
    );
    expect(
      await fixture.backend.readFile(`${fixture.trashDir}/blocked.webp`),
    ).toBe('original blocked image bytes');
  });

  test('single review restore still publishes the successfully restored image and refreshes trash', async () => {
    const caller = reviewCaller(fixture);
    await caller.loadTrash(fixture.scene);
    await caller.restoreTrashItem({ filename: 'good.png', deletedAt: 11 });
    expect(caller.appState.pushMessage).toHaveBeenCalledWith(
      'good.png 복원 완료',
    );
    expect(caller.items.get()).toEqual([
      {
        scene: fixture.scene,
        filename: 'good.png',
        path: `${fixture.outputDir}/good.png`,
      },
    ]);
    expect(caller.trashItems.get().map((entry) => entry.filename)).toEqual([
      'blocked.webp',
    ]);
    expect(
      await fixture.backend.readFile(`${fixture.outputDir}/good.png`),
    ).toBe('original good image bytes');
  });

  test('review click boundary reports hard metadata failure without a rejected event promise', async () => {
    const caller = reviewCaller(fixture);
    await caller.loadTrash(fixture.scene);
    await fixture.backend.writeFile(fixture.metadata, '{broken');
    await expect(
      caller.click({ filename: 'good.png', deletedAt: 11 })(),
    ).resolves.toBeUndefined();
    expect(caller.appState.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('복원 실패:'),
    );
    expect(caller.appState.pushMessage).not.toHaveBeenCalledWith(
      'good.png 복원 완료',
    );
    expect(caller.items.get()).toEqual([]);
    expect(caller.trashItems.get().map((entry) => entry.filename)).toContain(
      'good.png',
    );
    expect(await fixture.backend.readFile(`${fixture.trashDir}/good.png`)).toBe(
      'original good image bytes',
    );
  });
});
