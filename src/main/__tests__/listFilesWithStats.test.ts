/** @jest-environment node */
import { promises as fs, readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { runInThisContext } from 'vm';
import ts from 'typescript';

type ListedFile = { name: string; size: number; mtime: number };
type ListHandler = (event: unknown, directory: string) => Promise<ListedFile[]>;

// Execute the actual registered IPC callback without starting Electron or touching
// its profile. Only a failing stat boundary is injected; directory IO remains real.
function loadHandler(root: string, stat: typeof fs.stat): ListHandler {
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let handler: ts.Expression | undefined;
  for (const statement of source.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    ) {
      continue;
    }
    const call = statement.expression;
    if (
      ['ipcMain.handle', 'handleData'].includes(
        call.expression.getText(source),
      ) &&
      ts.isStringLiteral(call.arguments[0]) &&
      call.arguments[0].text === 'list-files-with-stats'
    ) {
      [, handler] = call.arguments;
      break;
    }
  }
  if (!handler)
    throw new Error('Missing production list-files-with-stats handler');
  const compiled = ts.transpileModule(
    `const handler = ${handler.getText(source)};`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  const createHandler = runInThisContext(
    `(function (fs, path, APP_DIR) {\n${compiled}\nreturn handler;\n})`,
    { filename: 'production-file-listing-fixture.js' },
  ) as (
    fileSystem: typeof fs,
    pathModule: typeof path,
    directory: string,
  ) => ListHandler;
  return createHandler({ ...fs, stat }, path, root);
}

describe('native file listing error ownership', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdstudio-file-list-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test('unexpected stat failure rejects instead of returning an incomplete listing', async () => {
    await fs.writeFile(path.join(root, 'saved.json'), '{"kept":true}');
    const failure = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const stat = (async () => {
      throw failure;
    }) as typeof fs.stat;
    await expect(loadHandler(root, stat)({}, '.')).rejects.toBe(failure);
    expect(await fs.readFile(path.join(root, 'saved.json'), 'utf8')).toBe(
      '{"kept":true}',
    );
  });

  test('a file removed after readdir is skipped while remaining metadata is preserved', async () => {
    const retained = path.join(root, 'retained.png');
    const removed = path.join(root, 'removed.png');
    await fs.writeFile(retained, Uint8Array.from([1, 2, 3]));
    await fs.writeFile(removed, Uint8Array.from([4]));
    await fs.mkdir(path.join(root, 'folder'));
    const expected = await fs.stat(retained);
    const stat = (async (file: Parameters<typeof fs.stat>[0]) => {
      if (String(file) === removed) await fs.unlink(removed);
      return fs.stat(file);
    }) as typeof fs.stat;
    await expect(loadHandler(root, stat)({}, '.')).resolves.toEqual([
      { name: 'retained.png', size: 3, mtime: expected.mtimeMs },
    ]);
    expect(await fs.readFile(retained)).toEqual(Buffer.from([1, 2, 3]));
  });
});
