/** @jest-environment node */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import { loadServiceMethods } from '../../renderer/models/testSupport/completionMethodHarness';

function loadDesktopExistence(channel: string, access: () => Promise<void>) {
  const filename = path.resolve(__dirname, '../main.ts');
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const handlers = source.statements.flatMap((statement) => {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      return [];
    const call = statement.expression;
    if (
      !['ipcMain.handle', 'handleData'].includes(
        call.expression.getText(source),
      ) ||
      !ts.isStringLiteral(call.arguments[0]) ||
      call.arguments[0].text !== channel
    )
      return [];
    return [call.arguments[1]];
  });
  if (handlers.length !== 1)
    throw new Error(`Expected one production ${channel} handler`);
  const compiled = ts.transpileModule(
    `const handler = ${handlers[0].getText(source)}; handler;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
      fileName: filename,
    },
  ).outputText;
  return new vm.Script(compiled, { filename }).runInNewContext({
    fs: { access },
    APP_DIR: '/fixture',
  }) as (event: unknown, name: string) => Promise<boolean>;
}

describe.each(['exist-file', 'exist-file-absolute'])(
  '%s retains storage failures',
  (channel) => {
    test.each(['EACCES', 'EPERM', 'EIO', 'EMFILE'])(
      '%s is not proof that a saved file is missing',
      async (code) => {
        const error = Object.assign(new Error('storage unavailable'), { code });
        const handler = loadDesktopExistence(channel, async () => {
          throw error;
        });
        await expect(handler(null, 'saved.json')).rejects.toBe(error);
      },
    );

    test.each(['ENOENT', 'ENOTDIR'])(
      '%s means the requested path cannot name an existing file',
      async (code) => {
        const handler = loadDesktopExistence(channel, async () => {
          throw Object.assign(new Error('absent'), { code });
        });
        await expect(handler(null, 'missing.json')).resolves.toBe(false);
      },
    );

    test('a successful filesystem query reports existence', async () => {
      const handler = loadDesktopExistence(channel, async () => undefined);
      await expect(handler(null, 'saved.json')).resolves.toBe(true);
    });
  },
);

describe.each(['existFile', 'existFileAbsolute'])(
  'Android %s retains storage failures',
  (method) => {
    function fixture(error?: Error, exists = true) {
      const pathExists = jest.fn(async () => {
        if (error) throw error;
        return { exists };
      });
      const Subject = loadServiceMethods(
        path.resolve(__dirname, '../../renderer/backends/androidBackend.ts'),
        'AndroidBackend',
        [method],
        {
          APP_DIR: '.SDStudio',
          Directory: {
            Documents: 'DOCUMENTS',
            ExternalStorage: 'EXTERNAL_STORAGE',
          },
          Filesystem: {
            stat: async () => {
              if (error) throw error;
              if (!exists) throw new Error('File does not exist');
              return {};
            },
          },
          ZipService: { pathExists },
        },
      );
      const subject = new Subject();
      return { call: () => subject[method]('saved.json'), pathExists };
    }

    test.each(['EACCES', 'EPERM', 'EIO'])(
      '%s reaches the store instead of making it appear empty',
      async (code) => {
        const error = Object.assign(new Error('storage unavailable'), { code });
        await expect(fixture(error).call()).rejects.toBe(error);
      },
    );

    test('a confirmed absent path returns false', async () => {
      await expect(fixture(undefined, false).call()).resolves.toBe(false);
    });

    test('existence comes from the errno-preserving native probe with the correct directory', async () => {
      const f = fixture();
      await expect(f.call()).resolves.toBe(true);
      expect(f.pathExists).toHaveBeenCalledWith(
        method === 'existFile'
          ? { path: '.SDStudio/saved.json', directory: 'DOCUMENTS' }
          : { path: 'Download/saved.json', directory: 'EXTERNAL_STORAGE' },
      );
    });
  },
);
