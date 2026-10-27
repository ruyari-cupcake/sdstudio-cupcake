/** @jest-environment node */
import { promises as fs, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { runInThisContext } from 'vm';
import ts from 'typescript';

interface NativeFixture {
  setConfig(value: Record<string, unknown>): Promise<void>;
  changeRoot(value: string): Promise<void>;
  state(): { config: Record<string, unknown>; pending: string | null };
}
function loadNativeConfig(
  root: string,
  initial: Record<string, unknown>,
  windowCount: () => number,
  rename: typeof fs.rename = fs.rename,
  transferCount = 0,
  appUpdateController = { isInstalling: false, isDownloading: false },
): NativeFixture {
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const selected = source.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement))
      return ['saveConfig', 'checkWritableFolder'].includes(
        statement.name?.text ?? '',
      );
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      return false;
    const call = statement.expression;
    return (
      call.expression.getText(source) === 'ipcMain.handle' &&
      ts.isStringLiteral(call.arguments[0]) &&
      ['set-config', 'change-save-location'].includes(call.arguments[0].text)
    );
  });
  const script = ts.transpileModule(
    `let config = initial; let configSavePromise = Promise.resolve();
let configLoadFailure = null; let storageRestartPending = null;
${selected.map((statement) => statement.getText(source)).join('\n')}
return {setConfig: (value) => handlers.get('set-config')({sender:{id:7}}, value),
changeRoot: (value) => handlers.get('change-save-location')({sender:{id:7}}, value),
state: () => ({config: {...config}, pending: storageRestartPending})};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const factory = runInThisContext(
    `(function(initial, fs, path, DEFAULT_APP_DIR, uuidv4, loadTagDatabase, broadcastGlobalStoreChanged, log, BrowserWindow, INSTALL_DIR, isSameOrInside, INSIDE_INSTALL_DIR_CODE, ipcMain, handlers, driveUploads, driveDownloads, appUpdateController) {${script}})`,
  ) as (...args: unknown[]) => NativeFixture;
  return factory(
    { ...initial },
    { ...fs, rename },
    path,
    root,
    randomUUID,
    async () => undefined,
    () => undefined,
    { warn: jest.fn() },
    {
      getAllWindows: () =>
        Array.from({ length: windowCount() }, () => ({
          isDestroyed: () => false,
        })),
    },
    null,
    () => false,
    'INSIDE_INSTALL_DIR',
    {
      handle: (
        name: string,
        callback: (...args: unknown[]) => Promise<void>,
      ) => {
        handlers.set(name, callback);
      },
    },
    handlers,
    new Map(Array.from({ length: transferCount }, (_, index) => [index, {}])),
    new Map(),
    appUpdateController,
  );
}
describe('native save-location configuration ownership', () => {
  let root: string;
  let initial: Record<string, unknown>;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cupcake-storage-config-'));
    initial = { saveLocation: path.join(root, 'active'), whiteMode: false };
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(initial));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('ordinary stale settings preserve the authoritative storage location', async () => {
    const subject = loadNativeConfig(root, initial, () => 1);
    await subject.setConfig({
      saveLocation: path.join(root, 'stale-path'),
      whiteMode: true,
    });
    expect(subject.state()).toEqual({
      config: { ...initial, whiteMode: true },
      pending: null,
    });
    expect(
      JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')),
    ).toEqual({ ...initial, whiteMode: true });
  });
  test('ordinary settings keep an absent saveLocation absent in memory and on disk, including failed replacement', async () => {
    const defaults = {};
    await fs.writeFile(
      path.join(root, 'config.json'),
      JSON.stringify(defaults),
    );
    let deny = false;
    const rename: typeof fs.rename = async (from, to) => {
      if (deny && String(to) === path.join(root, 'config.json'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await fs.rename(from, to);
    };
    const subject = loadNativeConfig(root, defaults, () => 1, rename);
    await subject.setConfig({
      saveLocation: path.join(root, 'caller-must-not-select-this'),
      whiteMode: true,
    });
    const saved = { whiteMode: true };
    expect({ ...subject.state().config }).toStrictEqual(saved);
    expect(subject.state().pending).toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(
        subject.state().config,
        'saveLocation',
      ),
    ).toBe(false);
    const diskBeforeFailure = await fs.readFile(
      path.join(root, 'config.json'),
      'utf8',
    );
    const persisted = JSON.parse(diskBeforeFailure);
    expect(persisted).toStrictEqual(saved);
    expect(
      Object.prototype.hasOwnProperty.call(persisted, 'saveLocation'),
    ).toBe(false);

    deny = true;
    await expect(
      subject.setConfig({
        saveLocation: path.join(root, 'another-caller-path'),
        whiteMode: false,
      }),
    ).rejects.toThrow('disk full');
    expect({ ...subject.state().config }).toStrictEqual(saved);
    expect(subject.state().pending).toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(
        subject.state().config,
        'saveLocation',
      ),
    ).toBe(false);
    expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(
      diskBeforeFailure,
    );
  });
  test('a selected folder commits durably and blocks later stale settings until restart', async () => {
    const subject = loadNativeConfig(root, initial, () => 1);
    const selected = path.join(root, 'chosen');
    await subject.changeRoot(selected);
    expect(subject.state()).toEqual({
      config: { ...initial, saveLocation: selected },
      pending: selected,
    });
    expect(
      JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')),
    ).toEqual({ ...initial, saveLocation: selected });
    await expect(subject.setConfig(initial)).rejects.toThrow('다시 시작');
    expect(subject.state().config.saveLocation).toBe(selected);
    expect(await fs.readdir(selected)).toEqual([]);
  });
  test('an inaccessible target or another live window cannot change the persisted location', async () => {
    const selected = path.join(root, 'blocked');
    await fs.writeFile(selected, 'keep');
    const subject = loadNativeConfig(root, initial, () => 1);
    await expect(subject.changeRoot(selected)).rejects.toThrow(
      '쓸 수 없습니다',
    );
    expect(subject.state()).toEqual({ config: initial, pending: null });
    const multi = loadNativeConfig(root, initial, () => 2);
    const unopened = path.join(root, 'must-not-create');
    await expect(multi.changeRoot(unopened)).rejects.toThrow(
      '다른 SDStudio 창',
    );
    await expect(fs.stat(unopened)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(
      JSON.stringify(initial),
    );
  });
  test('an active native Drive transfer preserves configuration and does not initialize the selected folder', async () => {
    const subject = loadNativeConfig(root, initial, () => 1, fs.rename, 1);
    const selected = path.join(root, 'transfer-must-finish');
    await expect(subject.changeRoot(selected)).rejects.toThrow('드라이브');
    expect(subject.state()).toEqual({ config: initial, pending: null });
    expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(
      JSON.stringify(initial),
    );
    await expect(fs.stat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test.each(['isInstalling', 'isDownloading'] as const)(
    'an updater with %s owns the storage root until it finishes',
    async (state) => {
      const updates = {
        isInstalling: false,
        isDownloading: false,
        [state]: true,
      };
      const subject = loadNativeConfig(
        root,
        initial,
        () => 1,
        fs.rename,
        0,
        updates,
      );
      const selected = path.join(root, 'update-must-finish');
      await expect(subject.changeRoot(selected)).rejects.toThrow('업데이트');
      expect(subject.state()).toEqual({ config: initial, pending: null });
      expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(
        JSON.stringify(initial),
      );
      await expect(fs.stat(selected)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
  test('failed atomic config replacement preserves the old disk and memory and a later explicit retry succeeds', async () => {
    let deny = true;
    const rename: typeof fs.rename = async (from, to) => {
      if (deny && String(to) === path.join(root, 'config.json'))
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await fs.rename(from, to);
    };
    const subject = loadNativeConfig(root, initial, () => 1, rename);
    const selected = path.join(root, 'chosen');
    await expect(subject.changeRoot(selected)).rejects.toThrow('disk full');
    expect(subject.state()).toEqual({ config: initial, pending: null });
    expect(await fs.readFile(path.join(root, 'config.json'), 'utf8')).toBe(
      JSON.stringify(initial),
    );
    deny = false;
    await subject.changeRoot(selected);
    expect(subject.state().config.saveLocation).toBe(selected);
    expect(subject.state().pending).toBe(selected);
  });
});
