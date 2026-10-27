import fs from 'fs';
import path from 'path';
import { runInThisContext } from 'vm';
import ts from 'typescript';
import {
  Session,
  Piece,
  PieceLibrary,
  isValidSession,
  isValidNAISPreset,
  isValidPieceLibrary,
} from '../types';
import {
  deferred,
  flushMicrotasks,
  loadServiceMethods,
} from '../testSupport/completionMethodHarness';

type Surface = 'drop' | 'editor';
type Scope = 'local' | 'global';

/** Run the production component's import closure and its real reloadDB helper.
 * React rendering is outside these cases; native file/store ports are injected,
 * while the actual import, ownership checks and success ordering are not mocked.
 */
function loadEditorImport(bindings: Record<string, unknown>) {
  const file = path.resolve(__dirname, '../../componenets/PieceEditor.tsx');
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const names = ['reloadDB', 'handleJsonImport'];
  const declarations = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      names.includes(node.name.text)
    ) {
      declarations.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const definitions = names.map((name) => {
    const declaration = declarations.get(name);
    if (!declaration?.initializer) throw new Error(`Missing actual ${name}`);
    return `const ${name} = ${declaration.initializer.getText(source)};`;
  });
  const compiled = ts.transpileModule(definitions.join('\n'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const factory = runInThisContext(
    `(function(${Object.keys(bindings).join(',')}) {
      ${compiled}
      return handleJsonImport;
    })`,
    { filename: file },
  );
  return factory(...Object.values(bindings)) as (file: File) => Promise<void>;
}

const input = {
  name: 'asset-pieces',
  version: 1,
  pieces: [{ name: 'eyes', prompt: '', multi: false }],
};

function fixture(
  surface: Surface,
  scope: Scope,
  options: { failedSave?: boolean; mirror?: boolean; foreign?: boolean } = {},
) {
  const session = Session.fromJSON({
    name: 'Target',
    version: 1,
    presets: {},
    presetShareds: {},
    scenes: {},
    inpaints: {},
    library: {},
  });
  const globalLibrary = new Map<string, PieceLibrary>();
  const saved = deferred<void>();
  const persisted = { json: '{}' };
  const save = jest.fn(async () => {
    if (options.failedSave) throw new Error('fixture-write-denied');
    await saved.promise;
    const groups = scope === 'local' ? session.library : globalLibrary;
    persisted.json = JSON.stringify(
      Object.fromEntries(
        [...groups].map(([name, library]) => [name, library.toJSON()]),
      ),
    );
  });
  const sessionService = {
    isMirror: jest.fn(() => !!options.mirror),
    guardCrossWindowLock: jest.fn(async () => !options.foreign),
    markDirty: jest.fn(),
    flushProjectNow: save,
    reloadPieceLibraryDB: jest.fn(async () => undefined),
  };
  const globalPieceService = {
    library: globalLibrary,
    scheduleSave: jest.fn(),
    flushSave: save,
    addLibrary: (name: string, library: PieceLibrary) => {
      globalLibrary.set(name, library);
    },
  };
  const appState = {
    curSession: session,
    pushDialogAsync: jest.fn(async () => scope),
    pushDialog: jest.fn(),
    pushMessage: jest.fn(),
  };
  const selected = jest.fn();
  const file = {
    name: 'asset-pieces.json',
    type: 'application/json',
    text: async () => JSON.stringify(input),
  } as File;
  const common = {
    sessionService,
    globalPieceService,
    isValidSession,
    isValidNAISPreset,
    isValidPieceLibrary,
    Piece,
    PieceLibrary,
    promptName: jest.fn(async () => 'asset-pieces-renamed'),
  };
  let run: () => Promise<unknown>;
  if (surface === 'drop') {
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../AppService.ts'),
      'AppState',
      ['handleFile'],
      {
        ...common,
        readImportFile: (value: File) => value.text(),
        isImportImageMime: () => false,
      },
    );
    const state = Object.assign(new Subject(), appState);
    run = () => state.handleFile(file);
  } else {
    const handler = loadEditorImport({
      ...common,
      scope,
      curSession: session,
      appState,
      setSelectedPieceLibrary: selected,
    });
    run = () => handler(file);
  }
  const destination = scope === 'local' ? session.library : globalLibrary;
  const successes = () => [
    ...appState.pushDialog.mock.calls,
    ...appState.pushMessage.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && /완료|불러왔습니다/.test(call[0]),
    ),
  ];
  return {
    run,
    saved,
    save,
    persisted,
    destination,
    sessionService,
    selected,
    successes,
    appState,
  };
}

describe.each<Surface>(['drop', 'editor'])(
  '%s prompt-piece file import completion',
  (surface) => {
    it.each<Scope>(['local', 'global'])(
      'waits for the %s store write and preserves a deliberately empty piece',
      async (scope) => {
        const f = fixture(surface, scope);
        let settled = false;
        const result = f.run().then(() => {
          settled = true;
          return undefined;
        });
        try {
          await flushMicrotasks();
          expect(f.save).toHaveBeenCalledTimes(1);
          expect(f.persisted.json).toBe('{}');
          expect(settled).toBe(false);
          expect(f.successes()).toEqual([]);
          expect(f.destination.get(input.name)?.pieces[0].prompt).toBe('');
          expect(f.sessionService.reloadPieceLibraryDB).not.toHaveBeenCalled();
        } finally {
          f.saved.resolve();
          await result;
        }
        expect(JSON.parse(f.persisted.json)[input.name].pieces).toEqual(
          input.pieces,
        );
        expect(f.sessionService.reloadPieceLibraryDB).toHaveBeenCalledTimes(1);
        expect(f.successes()).toHaveLength(1);
      },
    );

    it.each<Scope>(['local', 'global'])(
      'does not announce success when the %s store rejects its write',
      async (scope) => {
        const f = fixture(surface, scope, { failedSave: true });
        await f.run();
        expect(f.save).toHaveBeenCalledTimes(1);
        expect(f.persisted.json).toBe('{}');
        expect(f.successes()).toEqual([]);
        expect(f.appState.pushMessage.mock.calls.flat().join(' ')).toContain(
          'fixture-write-denied',
        );
        expect(f.sessionService.reloadPieceLibraryDB).not.toHaveBeenCalled();
        // A failed save retains the in-memory import for an ordinary save retry.
        expect(f.destination.get(input.name)?.pieces[0].prompt).toBe('');
      },
    );

    it.each([
      { label: 'read-only mirror', mirror: true },
      { label: 'another owning window', foreign: true },
    ])(
      'rejects local import in $label before mutating the group map',
      async (ownership) => {
        const f = fixture(surface, 'local', ownership);
        await f.run();
        expect([...f.destination]).toEqual([]);
        expect(f.save).not.toHaveBeenCalled();
        expect(f.successes()).toEqual([]);
        expect(f.sessionService.reloadPieceLibraryDB).not.toHaveBeenCalled();
      },
    );
  },
);
