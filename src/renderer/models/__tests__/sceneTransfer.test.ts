import path from 'path';
import {
  prepareSceneTransfer,
  applyImportedSceneSettings,
} from '../sceneTransfer';
import {
  Session,
  Scene,
  PieceLibrary,
  PromptPiece,
  isValidSession,
} from '../types';
import type { IScene, IPieceLibrary } from '../types';
import {
  loadServiceMethods,
  deferred,
} from '../testSupport/completionMethodHarness';

const scene = (prompt = '<a.eye>'): IScene => ({
  type: 'scene',
  name: 'smile',
  resolution: 'custom',
  resolutionWidth: 832,
  resolutionHeight: 1216,
  slots: [[{ id: 'one', prompt, characterPrompts: [] }]],
  imageMap: [],
  mains: [],
  meta: { AugmentGen: { emotion: 'happy' } },
  sceneUC: 'source negative',
  sceneSeed: 0,
  sceneCharacterUC: 'character negative',
});
const library = (name: string, prompt: string): IPieceLibrary => ({
  name,
  version: 1,
  pieces: [{ name: 'eye', prompt }],
});

describe('scene transfer references and target ownership', () => {
  it('closes transitive references and renames an otherwise identical parent when its dependency differs', () => {
    const source = { a: library('a', '<b.eye>'), b: library('b', 'incoming') };
    const target = new Map([
      ['a', library('a', '<b.eye>')],
      ['b', library('b', 'existing')],
    ]);
    const plan = prepareSceneTransfer([scene()], source, target);
    expect(plan.scenes[0].slots[0][0].prompt).toBe('<a_1.eye>');
    expect(plan.libraries.find((l) => l.name === 'a_1')?.pieces[0].prompt).toBe(
      '<b_1.eye>',
    );
    expect(plan.libraries.find((l) => l.name === 'b_1')?.pieces[0].prompt).toBe(
      'incoming',
    );
    expect(target.get('a')?.pieces[0].prompt).toBe('<b.eye>');
    expect(source.a.pieces[0].prompt).toBe('<b.eye>');
  });

  it('keeps cyclic references finite and copies only libraries required by the imported scenes', () => {
    const source = {
      a: library('a', '<b.eye>'),
      b: library('b', '<a.eye>'),
      unused: library('unused', 'ignore'),
    };
    const plan = prepareSceneTransfer([scene()], source, new Map());
    expect(plan.libraries.map((l) => l.name)).toEqual(['a', 'b']);
    expect(plan.libraries[1].pieces[0].prompt).toBe('<a.eye>');
  });

  it('does not shadow existing global groups and reserves their possible suffixes', () => {
    const plan = prepareSceneTransfer(
      [scene()],
      { a: library('a', '') },
      new Map(),
      new Map([
        ['a', library('a', 'global')],
        ['a_1', library('a_1', 'reserved')],
      ]),
    );
    expect(plan.libraries[0].name).toBe('a_2');
    expect(plan.libraries[0].pieces[0].prompt).toBe('');
    expect(plan.scenes[0].slots[0][0].prompt).toBe('<a_2.eye>');
  });

  it('reuses equal local groups including absent legacy multi=false without duplicating them', () => {
    const source = library('a', '');
    const target = library('a', '');
    target.pieces[0].multi = false;
    const plan = prepareSceneTransfer(
      [scene()],
      { a: source },
      new Map([['a', target]]),
    );
    expect(plan.libraries).toEqual([]);
    expect(plan.scenes[0].slots[0][0].prompt).toBe('<a.eye>');
  });

  it('replaces complete scene settings while retaining the target instance and generated image selections', () => {
    const target = Scene.fromJSON({
      ...scene('old'),
      sceneSeed: 9,
      imageMap: ['owned.png'],
      mains: ['owned.png'],
    });
    const ownedImages = target.imageMap;
    const input = {
      ...scene('new'),
      imageMap: ['foreign.png'],
      mains: ['foreign.png'],
    };
    applyImportedSceneSettings(target, input);
    expect(target.slots[0][0].prompt).toBe('new');
    expect(target.sceneSeed).toBe(0);
    expect(target.sceneUC).toBe('source negative');
    expect(target.resolutionWidth).toBe(832);
    expect(target.meta.get('AugmentGen')).toEqual({ emotion: 'happy' });
    expect(target.imageMap).toBe(ownedImages);
    expect(target.imageMap).toEqual(['owned.png']);
    expect(target.mains).toEqual(['owned.png']);
  });

  it('waits for actual scenes-only persistence and carries pieces through the real import dispatcher', async () => {
    const input = {
      name: 'Pack',
      version: 1,
      presets: {},
      inpaints: {},
      presetShareds: {},
      scenes: { smile: scene() },
      library: { a: library('a', '') },
    };
    const target = Session.fromJSON({
      ...input,
      name: 'Target',
      library: {},
      scenes: {
        smile: { ...scene('old'), imageMap: ['keep.png'], mains: ['keep.png'] },
      },
    });
    const saved = deferred<void>();
    const enteredSave = deferred<void>();
    const sessionService = {
      migrate: async (value: unknown) => value,
      markDirty: jest.fn(),
      guardCrossWindowLock: jest.fn(async () => true),
      isMirror: jest.fn(() => false),
      flushProjectNow: jest.fn(() => {
        enteredSave.resolve();
        return saved.promise;
      }),
      reloadPieceLibraryDB: jest.fn(async () => undefined),
    };
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../AppService.ts'),
      'AppState',
      ['handleFile'],
      {
        sessionService,
        globalPieceService: { library: new Map() },
        readImportFile: async () => JSON.stringify(input),
        isValidSession,
        isValidNAISPreset: () => false,
        isValidPieceLibrary: () => false,
        isImportImageMime: () => false,
        prepareSceneTransfer,
        applyImportedSceneSettings,
        Scene,
        PieceLibrary,
        PromptPiece,
        overlappingSceneNames: () => ['smile'],
        sceneImportOverwriteText: () => 'Replace?',
      },
    );
    const state = Object.assign(new Subject(), {
      curSession: target,
      pushDialogAsync: async () => 'cur-project',
      confirmAsync: async () => true,
      pushDialog: jest.fn(),
      pushMessage: jest.fn(),
    });
    const result = state.handleFile({ name: 'pack.json', type: '' });
    await enteredSave.promise;
    expect(sessionService.flushProjectNow).toHaveBeenCalledWith('Target');
    expect(state.pushDialog).not.toHaveBeenCalled();
    expect(target.library.get('a')?.pieces[0].prompt).toBe('');
    expect(target.scenes.get('smile')?.imageMap).toEqual(['keep.png']);
    saved.resolve();
    await result;
    expect(state.pushDialog).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'yes-only' }),
    );
    expect(sessionService.reloadPieceLibraryDB).toHaveBeenCalledWith(target);
  });
});
