/** @jest-environment node */
import { promises as fs, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { runInThisContext } from 'vm';
import ts from 'typescript';

type BootResult = {
  root: string;
  failure: { attempted: string; code: string } | null;
};
function loadBoot(defaultRoot: string, selectedRoot: string) {
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const init = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'initFolder',
  );
  if (!init) throw new Error('Missing native storage initializer');
  const compiled = ts.transpileModule(
    `let APP_DIR = DEFAULT_APP_DIR; let saveLocationFallback = null; let saveLocationInsideInstall = null;
${init.getText(source)}
return async () => { await initFolder(); return {root: APP_DIR, failure: saveLocationFallback}; };`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const create = runInThisContext(
    `(function(fs, path, config, DEFAULT_APP_DIR, INSTALL_DIR, uuidv4, log, chokidar, isSameOrInside) {${compiled}})`,
  ) as (...values: unknown[]) => () => Promise<BootResult>;
  return create(
    fs,
    path,
    { saveLocation: selectedRoot },
    defaultRoot,
    null,
    () => '4a060e37-42b5-4360-b35a-44df8354f68c',
    { warn: jest.fn() },
    { watch: jest.fn() },
    () => false,
  );
}
describe('desktop selected storage root without implicit fallback', () => {
  let fixture: string;
  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cupcake-storage-root-'));
  });
  afterEach(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
  });
  test('unavailable selected root remains selected and never creates the default data directory', async () => {
    const selected = path.join(fixture, 'selected-volume');
    await fs.writeFile(selected, 'volume unavailable: this path is a file');
    const defaultRoot = path.join(fixture, 'default-profile', 'SDStudio');
    const result = await loadBoot(defaultRoot, selected)();
    expect(result.root).toBe(selected);
    expect(result.failure).toEqual({ attempted: selected, code: 'EEXIST' });
    await expect(fs.stat(defaultRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(selected, 'utf8')).toBe(
      'volume unavailable: this path is a file',
    );
  });
  test('failure does not inspect or clean files under the previous/default data root', async () => {
    const selected = path.join(fixture, 'selected-volume');
    const defaultRoot = path.join(fixture, 'default-profile');
    await fs.writeFile(selected, 'occupied');
    await fs.mkdir(defaultRoot);
    const preserved = path.join(
      defaultRoot,
      '12345678-1234-4123-8123-123456789012',
    );
    await fs.writeFile(preserved, 'previous app data');
    const result = await loadBoot(defaultRoot, selected)();
    expect(result.failure?.attempted).toBe(selected);
    expect(await fs.readFile(preserved, 'utf8')).toBe('previous app data');
  });
  test('healthy selected root is used again on a fresh process without touching old project contents', async () => {
    const selected = path.join(fixture, 'selected-volume');
    const defaultRoot = path.join(fixture, 'default-profile');
    await fs.mkdir(defaultRoot);
    await fs.writeFile(
      path.join(defaultRoot, 'previous.json'),
      '{"keep":true}',
    );
    const first = await loadBoot(defaultRoot, selected)();
    await fs.writeFile(
      path.join(first.root, 'selected.json'),
      '{"saved":"selected"}',
    );
    const next = await loadBoot(defaultRoot, selected)();
    expect(next).toEqual({ root: selected, failure: null });
    expect(
      await fs.readFile(path.join(next.root, 'selected.json'), 'utf8'),
    ).toBe('{"saved":"selected"}');
    expect(
      await fs.readFile(path.join(defaultRoot, 'previous.json'), 'utf8'),
    ).toBe('{"keep":true}');
    expect(await fs.readdir(defaultRoot)).toEqual(['previous.json']);
  });
});
