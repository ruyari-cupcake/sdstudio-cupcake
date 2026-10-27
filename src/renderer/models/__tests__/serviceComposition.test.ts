const serviceModules = [
  {
    name: 'OpusUsageService',
    key: 'opusUsageService',
    path: '../OpusUsageService',
  },
  { name: 'SessionService', key: 'sessionService', path: '../SessionService' },
  { name: 'ImageService', key: 'imageService', path: '../ImageService' },
  { name: 'TrashService', key: 'trashService', path: '../TrashService' },
  {
    name: 'ImageDownloadService',
    key: 'imageDownloadService',
    path: '../ImageDownloadService',
  },
  {
    name: 'ProjectSizeService',
    key: 'projectSizeService',
    path: '../ProjectSizeService',
  },
  {
    name: 'TemplateService',
    key: 'templateService',
    path: '../TemplateService',
  },
  {
    name: 'ProjectTemplateService',
    key: 'projectTemplateService',
    path: '../ProjectTemplateService',
  },
  {
    name: 'ArtistTagService',
    key: 'artistTagService',
    path: '../ArtistTagService',
  },
  {
    name: 'GlobalPieceService',
    key: 'globalPieceService',
    path: '../GlobalPieceService',
  },
  {
    name: 'GlobalPresetService',
    key: 'globalPresetService',
    path: '../GlobalPresetService',
  },
  {
    name: 'GlobalCharacterPresetService',
    key: 'globalCharacterPresetService',
    path: '../GlobalCharacterPresetService',
  },
  {
    name: 'ArtistLibraryService',
    key: 'artistLibraryService',
    path: '../ArtistLibraryService',
  },
  { name: 'BackupService', key: 'backupService', path: '../BackupService' },
  {
    name: 'BatchProcessService',
    key: 'batchProcessService',
    path: '../BatchProcessService',
  },
  {
    name: 'ExportPresetService',
    key: 'exportPresetService',
    path: '../ExportPresetService',
  },
  { name: 'PromptService', key: 'promptService', path: '../PromptService' },
  {
    name: 'TaskQueueService',
    key: 'taskQueueService',
    path: '../TaskQueueService',
  },
  { name: 'LoginService', key: 'loginService', path: '../LoginService' },
  { name: 'GameService', key: 'gameService', path: '../GameService' },
  {
    name: 'ImageHistoryService',
    key: 'imageHistoryService',
    path: '../ImageHistoryService',
  },
  {
    name: 'AppUpdateNoticeService',
    key: 'appUpdateNoticeService',
    path: '../AppUpdateNoticeService',
  },
  { name: 'LocalAIService', key: 'localAIService', path: '../LocalAIService' },
  {
    name: 'CyclingSessionService',
    key: 'cyclingSessionService',
    path: '../CyclingSessionService',
  },
  {
    name: 'BackgroundNotificationService',
    key: 'backgroundNotificationService',
    path: '../BackgroundNotificationService',
  },
  {
    name: 'BackgroundKeepAliveService',
    key: 'backgroundKeepAliveService',
    path: '../BackgroundKeepAliveService',
  },
] as const;

const exposedKeys = [
  'electron',
  'promptService',
  'sessionService',
  'imageService',
  'imageDownloadService',
  'taskQueueService',
  'loginService',
  'globalPresetService',
] as const;
const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  jest.resetModules();
  for (const key of exposedKeys) {
    previousDescriptors.set(key, Object.getOwnPropertyDescriptor(window, key));
  }
  Object.defineProperty(window, 'electron', {
    configurable: true,
    writable: true,
    value: {},
  });
  jest.doMock('../../backends/electronBackend', () => ({
    ElectornBackend: jest.fn(() => ({})),
  }));
  jest.doMock('../../backends/androidBackend', () => ({
    AndroidBackend: jest.fn(() => ({})),
  }));
  for (const service of serviceModules) {
    jest.doMock(service.path, () => ({
      [service.name]: jest.fn(() => ({})),
      ...(service.name === 'ImageService'
        ? { toggleImageMain: jest.fn() }
        : {}),
    }));
  }
  jest.doMock('../TaskHandlers', () => ({ taskHandlers: [] }));
  jest.doMock('../workflows/workflowRegistry', () => ({ workFlowService: {} }));
  jest.doMock('../workflows', () => ({
    registerWorkFlows: jest.fn(() => {
      const services = jest.requireActual('..');
      return serviceModules.map(({ key }) => services[key] !== undefined);
    }),
  }));
});

afterEach(() => {
  for (const key of exposedKeys) {
    const descriptor = previousDescriptors.get(key);
    if (descriptor) Object.defineProperty(window, key, descriptor);
    else Reflect.deleteProperty(window, key);
  }
  previousDescriptors.clear();
  jest.resetModules();
});

function constructionCounts(): number[] {
  return serviceModules.map(({ name, path }) => {
    const constructor = jest.requireMock(path)[name] as jest.Mock;
    return constructor.mock.calls.length;
  });
}

describe('application service composition', () => {
  it('public singleton imports do not construct application services', () => {
    jest.isolateModules(() => {
      const services = jest.requireActual('..');
      expect(services.isMobile).toBe(false);
      expect(services.backend).toBeDefined();
      expect(services.workFlowService).toBeDefined();
      expect(constructionCounts()).toEqual(serviceModules.map(() => 0));
      expect(services.imageService).toBeUndefined();
    });
  });

  it('publishes shared instances before workflow registration and only constructs once', () => {
    jest.isolateModules(() => {
      const services = jest.requireActual('..');
      jest.requireActual('../composeServices');
      const publishedInstances = serviceModules.map(({ key, name, path }) => {
        const constructor = jest.requireMock(path)[name] as jest.Mock;
        return services[key] === constructor.mock.results[0].value;
      });
      expect(publishedInstances).toEqual(serviceModules.map(() => true));
      expect(constructionCounts()).toEqual(serviceModules.map(() => 1));
      expect(
        jest.requireMock('../GameService').GameService,
      ).toHaveBeenCalledWith(services.backend, services.imageService);
      const trashPorts =
        jest.requireMock('../TrashService').TrashService.mock.calls[0][0];
      const templatePorts =
        jest.requireMock('../TemplateService').TemplateService.mock.calls[0][0];
      const projectPorts = jest.requireMock('../ProjectTemplateService')
        .ProjectTemplateService.mock.calls[0][0];
      expect(trashPorts.templateService).toBe(services.templateService);
      expect(templatePorts.projectTemplateService).toBe(
        services.projectTemplateService,
      );
      expect(projectPorts.globalPresetService).toBe(
        services.globalPresetService,
      );
      expect(projectPorts.globalCharacterPresetService).toBe(
        services.globalCharacterPresetService,
      );
      const register = jest.requireMock('../workflows')
        .registerWorkFlows as jest.Mock;
      expect(register).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledWith(services.workFlowService);
      expect(register.mock.results[0].value).toEqual(
        serviceModules.map(() => true),
      );
      expect(window.imageService).toBe(services.imageService);
      expect(window.sessionService).toBe(services.sessionService);
      expect(window.taskQueueService).toBe(services.taskQueueService);
      jest.requireActual('../composeServices');
      expect(constructionCounts()).toEqual(serviceModules.map(() => 1));
      expect(register).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects a second installation without replacing published instances', () => {
    jest.isolateModules(() => {
      const services = jest.requireActual('..');
      jest.requireActual('../composeServices');
      const originalImageService = services.imageService;
      expect(() =>
        services.installServices({ ...services, imageService: {} }),
      ).toThrow('Application services are already installed.');
      expect(services.imageService).toBe(originalImageService);
    });
  });
});
