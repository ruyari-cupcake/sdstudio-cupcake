/** @jest-environment node */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';

/** Execute the production process-startup statements with native app seams. */
function start(lock: boolean, init: jest.Mock) {
  const source = fs.readFileSync(path.join(__dirname, '../main.ts'), 'utf8');
  const file = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const statements = file.statements
    .filter((statement) => {
      if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            ['initPromise', 'gotTheLock'].includes(declaration.name.text),
        );
      }
      return (
        ts.isIfStatement(statement) &&
        statement.expression.getText(file).includes('gotTheLock')
      );
    })
    .map((statement) => statement.getText(file))
    .join('\n');
  const app = {
    requestSingleInstanceLock: jest.fn(() => lock),
    quit: jest.fn(),
    on: jest.fn(),
    whenReady: jest.fn(() => Promise.resolve()),
  };
  let resolveCreated: () => void = () => undefined;
  const created = new Promise<void>((resolve) => {
    resolveCreated = resolve;
  });
  const createWindow = jest.fn(() => resolveCreated());
  const context = {
    app,
    init,
    createWindow,
    appUpdateController: undefined,
    focusAnyWindow: jest.fn(),
    killLocalAI: jest.fn(),
    BrowserWindow: { getAllWindows: () => [] },
    process: { platform: 'win32' },
    console,
    // Native updater wiring is part of primary startup and is inert in this test.
    registerAppUpdate: jest.fn(),
    APP_DIR: '/fixture/data',
    assertDataStorageAvailable: jest.fn(),
    getAssetPath: () => '/fixture/helper.ps1',
    driveUploads: new Map(),
    driveDownloads: new Map(),
  };
  vm.runInNewContext(
    ts.transpileModule(statements, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return { app, createWindow, created };
}
test('a rejected second process never starts filesystem or native initialization', () => {
  const init = jest.fn(async () => undefined);
  const { app, createWindow } = start(false, init);
  expect(app.quit).toHaveBeenCalledTimes(1);
  expect(init).not.toHaveBeenCalled();
  expect(app.whenReady).not.toHaveBeenCalled();
  expect(createWindow).not.toHaveBeenCalled();
});
test('the primary process still awaits loaded data before creating its first window', async () => {
  let resolveInit: (() => void) | undefined;
  const init = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveInit = resolve;
      }),
  );
  const { app, createWindow, created } = start(true, init);
  expect(init).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(createWindow).not.toHaveBeenCalled();
  resolveInit!();
  await created;
  expect(createWindow).toHaveBeenCalledTimes(1);
  expect(app.quit).not.toHaveBeenCalled();
});
