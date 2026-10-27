/** @jest-environment node */
import { readFileSync } from 'fs';
import path from 'path';
import { runInThisContext } from 'vm';
import ts from 'typescript';
import { OUTPUT_IMAGE_EXTS } from '../../renderer/models/imageFormats';

type ChangeListener = (changedPath: string) => Promise<void>;

// Execute the real watcher registration and callback without booting Electron or
// duplicating its path predicate. This also covers Windows separators on Linux.
function loadRefreshWatch(
  selectedRoot: string,
  paths: typeof path.posix,
  enabled = true,
) {
  const source = ts.createSourceFile(
    'main.ts',
    readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const initializer = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'initFolder',
  );
  const registration = initializer?.body?.statements.find(
    (statement) =>
      ts.isIfStatement(statement) &&
      statement.expression.getText(source) === 'config.refreshImage',
  );
  if (!registration) throw new Error('Missing native image refresh watcher');
  const compiled = ts.transpileModule(registration.getText(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  let onChange: ChangeListener | undefined;
  const handle = {
    on: jest.fn((event: string, callback: ChangeListener) => {
      if (event === 'change') onChange = callback;
    }),
  };
  const watch = jest.fn(() => handle);
  const broadcast = jest.fn();
  const register = runInThisContext(
    `(function(APP_DIR, path, config, chokidar, broadcast, OUTPUT_IMAGE_EXTS) {${compiled}})`,
  ) as (...bindings: unknown[]) => void;
  register(
    selectedRoot,
    paths,
    { refreshImage: enabled },
    { watch },
    broadcast,
    OUTPUT_IMAGE_EXTS,
  );
  return {
    watch,
    broadcast,
    change: async (relativePath: string) => {
      if (!onChange) throw new Error('No image change callback was registered');
      await onChange(paths.resolve(selectedRoot, ...relativePath.split('/')));
    },
  };
}

describe.each([
  {
    platform: 'POSIX',
    selectedRoot: '/selected-volume/SDStudio',
    paths: path.posix,
  },
  {
    platform: 'Windows',
    selectedRoot: 'E:\\chosen-data\\SDStudio',
    paths: path.win32,
  },
])('native image refresh watcher on $platform', ({ selectedRoot, paths }) => {
  test('does not broadcast metadata, temporary files, or non-image changes', async () => {
    const fixture = loadRefreshWatch(selectedRoot, paths);
    for (const relativePath of [
      'workspace/project/project.json',
      'workspace/project/outs/scene/.trash/.trash_meta.json',
      'workspace/project/outs/scene/output.png.bak',
      'workspace/project/notes.txt',
      'workspace/project/12345678-1234-4123-8123-123456789012',
    ]) {
      await fixture.change(relativePath);
    }
    expect(fixture.broadcast).not.toHaveBeenCalled();
  });

  test('does not feed derived thumbnail changes back to renderers', async () => {
    const fixture = loadRefreshWatch(selectedRoot, paths);
    for (const relativePath of [
      'outs/project/scene/fastcache/400_output.png',
      'inpaints/project/scene/fastcache/200_output.webp',
      'workspace/project/outs/scene/fastcache/500_output.png',
      'workspace/project/outs/scene/.trash/fastcache/400_output.webp',
    ]) {
      await fixture.change(relativePath);
    }
    expect(fixture.broadcast).not.toHaveBeenCalled();
  });

  test('broadcasts each supported original change once with a normalized relative path', async () => {
    const fixture = loadRefreshWatch(selectedRoot, paths);
    expect(fixture.watch).toHaveBeenCalledWith(selectedRoot, {
      persistent: true,
      ignoreInitial: true,
      usePolling: false,
    });
    for (const relativePath of [
      'outs/project/scene/output.png',
      'inpaints/project/scene/output.webp',
      'workspace/project/outs/scene/output.PNG',
      'workspace/project/inpaints/scene/output.webp',
      'workspace/project/vibes/reference.jpg',
      'workspace/project/vibes/reference.JPEG',
      'workspace/project/outs/scene/.trash/output.webp',
      'workspace/project/outs/scene/fastcache-style.png',
    ]) {
      fixture.broadcast.mockClear();
      await fixture.change(relativePath);
      expect(fixture.broadcast).toHaveBeenCalledTimes(1);
      expect(fixture.broadcast).toHaveBeenCalledWith(
        'image-changed',
        relativePath,
      );
    }
  });

  test('keeps unrelated roots and sibling paths outside the refresh contract', async () => {
    const fixture = loadRefreshWatch(selectedRoot, paths);
    await fixture.change('artist-library/images/sample.png');
    await fixture.change('../outside/outs/project/scene/output.png');
    expect(fixture.broadcast).not.toHaveBeenCalled();
  });

  test('registers no watcher when refreshImage is disabled', () => {
    const fixture = loadRefreshWatch(selectedRoot, paths, false);
    expect(fixture.watch).not.toHaveBeenCalled();
    expect(fixture.broadcast).not.toHaveBeenCalled();
  });
});
