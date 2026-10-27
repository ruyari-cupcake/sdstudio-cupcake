/** Legacy project/scene contracts derived from the uploaded v1 formats.
 * Small synthetic prompts keep private shared assets out of the public source.
 */
import path from 'path';
import { Session, PieceLibrary } from '../types';
import { TemplateService } from '../TemplateService';
import type { TemplateServiceDependencies } from '../TemplateService';
import { loadServiceMethods } from '../testSupport/completionMethodHarness';

const mockApp = {
  curSession: undefined as Session | undefined,
  pushMessage: jest.fn(),
  pushDialog: jest.fn(),
  pushDialogAsync: jest.fn(),
  confirmAsync: jest.fn(async () => true),
};
jest.mock('../appStateRef', () => ({ getAppState: () => mockApp }));
jest.mock('../PersistenceService', () => ({
  persistService: { write: jest.fn(async () => undefined) },
}));

function project(name = 'Legacy emotions', eyePrompt = '') {
  return {
    name,
    version: 1,
    presets: {},
    inpaints: {},
    presetShareds: {},
    library: {
      expressions: {
        name: 'expressions',
        version: 1,
        pieces: [{ name: 'eyes', prompt: eyePrompt, multi: false }],
      },
    },
    scenes: {
      smile: {
        name: 'smile',
        type: 'scene' as const,
        resolution: 'portrait',
        slots: [
          [
            {
              id: 'old-piece',
              prompt: 'smile, <expressions.eyes>',
              characterPrompts: [],
            },
          ],
        ],
        imageMap: [],
        mains: [],
        meta: { AugmentGen: { emotion: 'happy' } },
        sceneUC: 'unwanted',
        sceneSeed: 7,
        sceneCharacterUC: 'character negative',
        sceneCharacterPrompts: [
          {
            id: 'character-1',
            prompt: '<expressions.eyes>',
            uc: '',
            position: { x: 0.5, y: 0.5 },
            enabled: true,
          },
        ],
        useSceneCharacterPrompts: true,
      },
    },
  };
}

function templateHarness(source = project()) {
  const stored = new Map<string, Session>();
  const sourceSession = Session.fromJSON(source);
  stored.set(sourceSession.name, sourceSession);
  const services = {
    backend: {
      existFile: jest.fn(async () => false),
      readFile: jest.fn(),
      writeFile: jest.fn(),
    },
    sessionService: {
      list: () => [...stored.keys()],
      get: jest.fn(async (name: string) => stored.get(name)),
      add: jest.fn(),
      getFolderOf: jest.fn(),
      exportSessionShallow: jest.fn(async (s: Session) => s.toJSON()),
      importSessionShallow: jest.fn(
        async (json: ReturnType<typeof project>, name: string) => {
          stored.set(name, Session.fromJSON({ ...json, name }));
        },
      ),
      reloadPieceLibraryDB: jest.fn(async () => undefined),
      flushProjectNow: jest.fn(async () => undefined),
      markDirty: jest.fn(),
      guardCrossWindowLock: jest.fn(async () => true),
      isMirror: jest.fn(() => false),
    },
    trashService: { moveSceneToTrash: jest.fn() },
    projectTemplateService: {
      ensureLoaded: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
    },
  };
  const service = new TemplateService(
    services as unknown as TemplateServiceDependencies,
  );
  service.sceneNames = [sourceSession.name];
  mockApp.pushDialogAsync.mockResolvedValue(sourceSession.name);
  return { service, services, stored, sourceSession };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApp.curSession = undefined;
  mockApp.confirmAsync.mockResolvedValue(true);
});

describe('legacy scene files and their prompt dependencies', () => {
  it('accepts a v1 whole project as a reusable scene template, preserving embedded data', async () => {
    const { service, services, stored } = templateHarness();
    const input = project('Older shared emotions');
    const name = await service.importSceneTemplateFile(JSON.stringify(input));
    expect(name).toBe(input.name);
    expect(service.listSceneTemplates()).toContain(input.name);
    expect(services.sessionService.importSessionShallow).toHaveBeenCalledWith(
      expect.objectContaining({ scenes: input.scenes, library: input.library }),
      input.name,
    );
    expect(
      stored.get(input.name)?.library.get('expressions')?.pieces[0].prompt,
    ).toBe('');
  });

  it('keeps the current scene-template envelope compatible', async () => {
    const { service } = templateHarness();
    const input = project('Envelope');
    expect(
      await service.importSceneTemplateFile(
        JSON.stringify({
          version: 1,
          type: 'sdstudio-scene-template',
          name: 'Envelope',
          session: input,
        }),
      ),
    ).toBe('Envelope');
  });

  it('copies local pieces with scenes, waits for saving and preserves legacy enabled omission', async () => {
    const { service, services } = templateHarness();
    const target = Session.fromJSON({
      ...project('Target'),
      scenes: {},
      library: {},
    });
    mockApp.curSession = target;
    const result = await service.importSceneTemplate(target);
    expect(result).toEqual(['smile']);
    expect(target.scenes.get('smile')?.slots[0][0].enabled).not.toBe(false);
    expect(target.library.get('expressions')?.pieces[0].prompt).toBe('');
    expect(target.scenes.get('smile')?.sceneSeed).toBe(7);
    expect(target.scenes.get('smile')?.meta.get('AugmentGen')).toEqual({
      emotion: 'happy',
    });
    expect(services.sessionService.flushProjectNow).toHaveBeenCalledWith(
      'Target',
    );
  });

  it('renames conflicting piece groups and rewrites imported references without changing existing prompts', async () => {
    const { service, sourceSession } = templateHarness(
      project('Template', 'incoming eyes'),
    );
    const target = Session.fromJSON({
      ...project('Target', 'existing eyes'),
      scenes: {},
    });
    target.library.set(
      'expressions_1',
      PieceLibrary.fromJSON({
        name: 'expressions_1',
        version: 1,
        pieces: [{ name: 'eyes', prompt: 'reserved' }],
      }),
    );
    mockApp.curSession = target;
    await service.importSceneTemplate(target);
    expect(target.library.get('expressions')?.pieces[0].prompt).toBe(
      'existing eyes',
    );
    expect(target.library.get('expressions_1')?.pieces[0].prompt).toBe(
      'reserved',
    );
    expect(target.library.get('expressions_2')?.pieces[0].prompt).toBe(
      'incoming eyes',
    );
    expect(target.scenes.get('smile')?.slots[0][0].prompt).toBe(
      'smile, <expressions_2.eyes>',
    );
    expect(target.scenes.get('smile')?.sceneCharacterPrompts[0].prompt).toBe(
      '<expressions_2.eyes>',
    );
    expect(sourceSession.scenes.get('smile')?.slots[0][0].prompt).toBe(
      'smile, <expressions.eyes>',
    );
  });

  it('does not claim successful copying when the project save fails', async () => {
    const { service, services } = templateHarness();
    const target = Session.fromJSON({
      ...project('Target'),
      scenes: {},
      library: {},
    });
    mockApp.curSession = target;
    services.sessionService.flushProjectNow.mockRejectedValueOnce(
      new Error('disk full'),
    );
    await expect(service.importSceneTemplate(target)).rejects.toThrow(
      'disk full',
    );
    expect(mockApp.pushMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('프로젝트로 복사했습니다'),
    );
  });

  it('does not dereference null or accept a prompt-piece file as a scene project', async () => {
    const { service, services } = templateHarness();
    expect(await service.importSceneTemplateFile('null')).toBeNull();
    expect(
      await service.importSceneTemplateFile(
        JSON.stringify({
          name: 'Pieces',
          version: 1,
          pieces: [{ name: 'eyes', prompt: '' }],
        }),
      ),
    ).toBeNull();
    expect(services.sessionService.importSessionShallow).not.toHaveBeenCalled();
  });
});

describe('file picker JSON recognition', () => {
  it.each(['', 'application/octet-stream'])(
    'imports a .JSON project even when the OS reports MIME %p',
    async (type) => {
      const input = project();
      const imported = { name: input.name };
      const sessionService = {
        get: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockResolvedValue(imported),
        importSessionShallow: jest.fn(async () => undefined),
      };
      const Subject = loadServiceMethods(
        path.resolve(__dirname, '../AppService.ts'),
        'AppState',
        ['handleFile'],
        {
          sessionService,
          readImportFile: async () => JSON.stringify(input),
          isValidSession: (value: unknown) =>
            !!value && typeof value === 'object' && 'scenes' in value,
          isValidNAISPreset: () => false,
          isValidPieceLibrary: () => false,
          isImportImageMime: () => false,
          nameErrorMessage: () => 'failed',
        },
      );
      const state = Object.assign(new Subject(), {
        curSession: undefined,
        pushDialog: jest.fn(),
        pushMessage: jest.fn(),
      });
      expect(await state.handleFile({ name: 'emotions.JSON', type })).toEqual([
        input.name,
      ]);
      expect(sessionService.importSessionShallow).toHaveBeenCalledTimes(1);
    },
  );
});
