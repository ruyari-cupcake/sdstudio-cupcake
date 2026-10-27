import { CharacterPreset } from '../CharacterPreset';
import { Session } from '../Session';
import type { ProjectTemplateService as ProjectTemplates } from '../ProjectTemplateService';
import type { TemplateService as Templates } from '../TemplateService';

jest.mock('..', () => {
  throw new Error('Template services must not construct the application');
});

describe('template and trash service ports', () => {
  it.each([
    ['TemplateService', '../TemplateService'],
    ['TrashService', '../TrashService'],
    ['ProjectTemplateService', '../ProjectTemplateService'],
  ])('loads %s without application construction', (className, modulePath) => {
    const loaded = jest.requireActual(modulePath);
    expect(typeof loaded[className]).toBe('function');
  });

  it('preserves construction order and resolves later dependencies only when operations use them', async () => {
    jest.useFakeTimers();
    try {
      const { TrashService } =
        jest.requireActual<typeof import('../TrashService')>('../TrashService');
      const { TemplateService } =
        jest.requireActual<typeof import('../TemplateService')>(
          '../TemplateService',
        );
      const { ProjectTemplateService } = jest.requireActual<
        typeof import('../ProjectTemplateService')
      >('../ProjectTemplateService');
      const files = new Map<string, string>([
        [
          'templates.json',
          JSON.stringify({
            version: 1,
            sceneTemplates: ['retired'],
            hiddenSceneTemplates: ['retired'],
            folderTemplates: { folder: { templateId: 'template' } },
          }),
        ],
        [
          'project_templates.json',
          JSON.stringify({
            version: 1,
            templates: [
              {
                id: 'template',
                name: 'Template',
                createdAt: 1,
                updatedAt: 1,
                preset: { name: 'owned name', profile: 'owned.png' },
                characterPresets: [],
                vibes: [],
                characterReferences: [],
                scenes: [],
              },
            ],
          }),
        ],
      ]);
      const storage = {
        existFile: jest.fn(async (path: string) => files.has(path)),
        readFile: jest.fn(async (path: string) => {
          const contents = files.get(path);
          if (contents === undefined) throw new Error('Missing fixture file');
          return contents;
        }),
        writeFile: jest.fn(async (path: string, data: string) => {
          files.set(path, data);
        }),
        renameFile: jest.fn(async (from: string, to: string) => {
          const contents = files.get(from);
          if (contents === undefined) throw new Error('Missing fixture file');
          files.set(to, contents);
          files.delete(from);
        }),
        listFiles: jest.fn(async () => []),
        listFilesWithStats: jest.fn(async () => []),
        deleteFile: jest.fn(async () => undefined),
        deleteDir: jest.fn(async () => undefined),
        renameDir: jest.fn(async () => undefined),
        notifyGlobalStoreChanged: jest.fn(async () => undefined),
        readDataFile: jest.fn(async () => ''),
        writeDataFile: jest.fn(async () => undefined),
        copyFile: jest.fn(async () => undefined),
      };
      const session = new Session();
      const sessions = {
        list: jest.fn(() => []),
        getFolderOf: jest.fn(() => null),
        get: jest.fn(async () => session),
        add: jest.fn(async () => undefined),
        exportSessionShallow: jest.fn(async () => session.toJSON()),
        importSessionShallow: jest.fn(async () => undefined),
        reloadPieceLibraryDB: jest.fn(async () => undefined),
        flushProjectNow: jest.fn(async () => undefined),
        markDirty: jest.fn(),
        guardCrossWindowLock: jest.fn(async () => true),
        isMirror: jest.fn(() => false),
      };
      const images = {
        invalidateCacheBatch: jest.fn(async () => undefined),
        getVibeImagePath: jest.fn(() => ''),
        getReferenceImagePath: jest.fn(() => ''),
        storeVibeImage: jest.fn(async () => ''),
        storeReferenceImage: jest.fn(async () => ''),
      };
      const workflows = {
        presetFromJSON: jest.fn(),
        buildShared: jest.fn(),
      };
      const styleSource = {
        get: jest.fn(() => ({
          id: 'style',
          name: 'Style',
          workflowType: 'SDImageGenEasy' as const,
          isDefault: false,
          createdAt: 1,
          updatedAt: 1,
          preset: { name: 'foreign name', frontPrompt: 'later style' },
        })),
      };
      const character = new CharacterPreset();
      character.name = 'Character';
      const characterSource = {
        get: jest.fn(() => ({
          id: 'character',
          name: 'Character',
          createdAt: 1,
          updatedAt: 1,
          preset: character.toJSON(),
        })),
        fetchImageData: jest.fn(async () => null),
      };
      const lateReads: string[] = [];
      let templates: Templates | undefined;
      let projectTemplates: ProjectTemplates | undefined;
      let globalsReady = false;

      const trash = new TrashService({
        backend: storage,
        sessionService: sessions,
        imageService: images,
        get templateService(): Templates {
          lateReads.push('templates');
          if (!templates) throw new Error('Templates read before construction');
          return templates;
        },
      });
      templates = new TemplateService({
        backend: storage,
        sessionService: sessions,
        trashService: trash,
        get projectTemplateService(): ProjectTemplates {
          lateReads.push('project templates');
          if (!projectTemplates) {
            throw new Error('Project templates read before construction');
          }
          return projectTemplates;
        },
      });
      projectTemplates = new ProjectTemplateService({
        backend: storage,
        sessionService: sessions,
        imageService: images,
        workFlowService: workflows,
        templateService: templates,
        get globalPresetService() {
          lateReads.push('global presets');
          if (!globalsReady) throw new Error('Global presets read too early');
          return styleSource;
        },
        get globalCharacterPresetService() {
          lateReads.push('global characters');
          if (!globalsReady)
            throw new Error('Global characters read too early');
          return characterSource;
        },
      });

      expect(lateReads).toEqual([]);
      expect(storage.existFile).not.toHaveBeenCalled();
      expect(storage.readFile).not.toHaveBeenCalled();
      expect(storage.writeFile).not.toHaveBeenCalled();
      globalsReady = true;

      await expect(
        templates.resolveFolderTemplate('folder/child'),
      ).resolves.toEqual({
        folder: 'folder',
        templateId: 'template',
      });
      await projectTemplates.importGlobalPreset('template', 'style');
      expect(styleSource.get).toHaveBeenCalledWith('style');
      expect(projectTemplates.get('template')?.preset).toEqual({
        type: 'SDImageGenEasy',
        name: 'owned name',
        profile: 'owned.png',
        frontPrompt: 'later style',
      });
      await projectTemplates.importGlobalCharacterPreset(
        'template',
        'character',
      );
      expect(characterSource.get).toHaveBeenCalledWith('character');
      expect(projectTemplates.get('template')?.characterPresets[0].name).toBe(
        'Character',
      );

      const removeProject = jest.spyOn(templates, 'removeProject');
      await trash.loadTrash();
      await trash.permanentlyDeleteProject('retired');
      expect(removeProject).toHaveBeenCalledWith('retired');
      expect(templates.hiddenNames).not.toContain('retired');
      expect(lateReads).toEqual(
        expect.arrayContaining([
          'templates',
          'project templates',
          'global presets',
          'global characters',
        ]),
      );
      expect(storage.writeFile).toHaveBeenCalledWith(
        'templates.json',
        expect.any(String),
      );
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
