import path from 'path';
import { loadServiceMethods } from '../testSupport/completionMethodHarness';
import { Session, Scene, PieceLibrary, isValidSession } from '../types';
import {
  prepareSceneTransfer,
  applyImportedSceneSettings,
} from '../sceneTransfer';

function harness(mirror: boolean, allowed: boolean) {
  const source = Session.fromJSON({
    name: 'Source',
    version: 1,
    presets: {},
    inpaints: {},
    presetShareds: {},
    scenes: {
      imported: {
        type: 'scene',
        name: 'imported',
        resolution: 'portrait',
        slots: [[{ id: 'choice', prompt: '<a.eye>', characterPrompts: [] }]],
        imageMap: [],
        mains: [],
        meta: {},
      },
    },
    library: {
      a: {
        name: 'a',
        version: 1,
        pieces: [{ name: 'eye', prompt: 'source-eye' }],
      },
    },
  });
  const target = Session.fromJSON({
    name: 'Target',
    version: 1,
    scenes: {},
    presets: {},
    inpaints: {},
    presetShareds: {},
    library: {},
  });
  const services = {
    get: jest.fn(async () => source),
    migrate: jest.fn(async (json: unknown) => json),
    guardCrossWindowLock: jest.fn(async () => allowed),
    isMirror: jest.fn(() => mirror),
    markDirty: jest.fn(),
    flushProjectNow: jest.fn(async () => undefined),
    reloadPieceLibraryDB: jest.fn(async () => undefined),
  };
  const state = {
    curSession: target,
    pushMessage: jest.fn(),
    pushDialog: jest.fn(),
    pushDialogAsync: jest.fn(async () => 'cur-project'),
    confirmAsync: jest.fn(async () => true),
  };
  return { source, target, services, state };
}

describe.each([
  ['read-only mirror', true, true],
  ['another window owns the project', false, false],
] as const)('scene import access: %s', (_label, mirror, allowed) => {
  it('keeps current-project file imports from mutating or reporting success', async () => {
    const { source, target, services, state } = harness(mirror, allowed);
    const before = target.toJSON();
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../AppService.ts'),
      'AppState',
      ['handleFile'],
      {
        sessionService: services,
        globalPieceService: { library: new Map() },
        readImportFile: async () => JSON.stringify(source.toJSON()),
        isValidSession,
        isValidNAISPreset: () => false,
        isValidPieceLibrary: () => false,
        isImportImageMime: () => false,
        prepareSceneTransfer,
        applyImportedSceneSettings,
        Scene,
        PieceLibrary,
        overlappingSceneNames: () => [],
        sceneImportOverwriteText: () => 'Replace?',
      },
    );
    const app = Object.assign(new Subject(), state);
    await expect(
      app.handleFile({ name: 'source.JSON', type: '' }),
    ).resolves.toEqual([]);
    expect(target.toJSON()).toEqual(before);
    expect(services.flushProjectNow).not.toHaveBeenCalled();
    expect(state.pushDialog).not.toHaveBeenCalled();
  });

  it('keeps reusable-template imports from mutating or reporting success', async () => {
    const { target, services, state } = harness(mirror, allowed);
    state.pushDialogAsync.mockResolvedValue('Source');
    const before = target.toJSON();
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../TemplateService.ts'),
      'TemplateService',
      ['importSceneTemplate'],
      {
        getAppState: () => state,
        prepareSceneTransfer,
        Scene,
        PieceLibrary,
      },
    );
    const service = Object.assign(new Subject(), {
      ensureLoaded: async () => undefined,
      listSceneTemplates: () => ['Source'],
      services: {
        sessionService: services,
        trashService: {},
        globalPieceService: { library: new Map() },
      },
    });
    await expect(service.importSceneTemplate(target)).resolves.toBeNull();
    expect(target.toJSON()).toEqual(before);
    expect(services.flushProjectNow).not.toHaveBeenCalled();
    expect(state.pushMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('복사했습니다'),
    );
  });
});
