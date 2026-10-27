/** Real handler + queue contracts: stopping affects the next dispatch, not a result already in flight. */

import type { Task, TaskHandler, TaskQueueService } from '../TaskQueueService';

const saved = new Set<string>();
const generateImage = jest.fn(async (arg: any) => {
  saved.add(arg.outputFilePath);
});
const getConfig = jest.fn(async () => ({
  requestDelayMs: 0,
  requestDelayJitterMs: 0,
}));
const encodeVibeImage = jest.fn(async (_session: unknown, _path: string) => {});
const checkEncodedVibeImage = jest.fn(async () => false);
const fetchEncodedVibeImage = jest.fn(
  async () => 'data:application/octet-stream;base64,ENCODED',
);
const fetchReferenceImage = jest.fn(
  async (_session: unknown, path: string) => `data:image/png;base64,${path}`,
);
const reencodeReferenceForApi = jest.fn(
  async (image: string) => `PNG:${image}`,
);
const onAddImage = jest.fn();
const onAddInPaint = jest.fn();
const removeImageReference = jest.fn();
const refresh = jest.fn(async () => ({
  opusSubscribed: true,
  percent: 0,
  isNegative: false,
}));
const isPaidRisk = jest.fn(() => false);
const approvePaidRisk = jest.fn();
const confirmAsync = jest.fn(async () => true);

jest.mock('..', () => ({
  backend: {
    getConfig,
    generateImage,
    delegateComplete: jest.fn(async () => {}),
    delegateQueueSnapshot: jest.fn(async () => {}),
    readDataFile: jest.fn(async () => 'data:image/png;base64,IMAGE'),
  },
  imageService: {
    encodeVibeImage,
    checkEncodedVibeImage,
    fetchEncodedVibeImage,
    fetchReferenceImage,
    reencodeReferenceForApi,
    onAddImage,
    onAddInPaint,
    removeImageReference,
  },
  opusUsageService: {
    refresh,
    takeLowWarning: () => false,
    isPaidRisk,
    hasSessionPaidApproval: () => false,
    approvePaidRisk,
  },
  isMobile: false,
  localAIService: {},
  loginService: {},
  promptService: {},
  sessionService: {},
  taskQueueService: { stop: jest.fn() },
  workFlowService: {},
}));
jest.mock('../AppService', () => ({
  appState: { pushMessage: jest.fn(), pushDialog: jest.fn(), confirmAsync },
}));
jest.mock('../PersistenceService', () => ({
  persistService: { write: jest.fn(async () => {}) },
}));
jest.mock('../PromptService', () => ({
  expandPieces: (value: string) => value,
  lowerPromptNode: (value: { text: string }) => value.text,
  toPARR: jest.fn(),
}));
jest.mock('../ImageService', () => ({
  dataUriToBase64: (value: string) =>
    value.includes(',') ? value.split(',')[1] : value,
}));
jest.mock('../workflows/SDWorkFlow', () => ({
  prepareMirrorCanvas: jest.fn(),
}));
jest.mock('../../componenets/BrushTool', () => ({
  getImageDimensions: jest.fn(),
}));

// Load the subject after its mock fixtures have been initialized.
const { ModelVersion, Resolution } = jest.requireActual<
  typeof import('../../backends/imageGen')
>('../../backends/imageGen');
const { TaskQueueService: TaskQueueServiceRuntime } = jest.requireActual<
  typeof import('../TaskQueueService')
>('../TaskQueueService');
const { taskHandlers } =
  jest.requireActual<typeof import('../TaskHandlers')>('../TaskHandlers');

function task(
  version = ModelVersion.V4_5,
  references: string[] = [],
  vibes: string[] = [],
): Task {
  return {
    id: 'dispatch-task',
    cls: 0,
    done: 0,
    total: 1,
    params: {
      session: { name: 'project' },
      scene: {
        name: 'scene',
        type: 'scene',
        resolution: Resolution.Custom,
        resolutionWidth: 832,
        resolutionHeight: 1216,
      },
      outputPath: 'outs/project/scene',
      nodelay: false,
      generationSnapshot: {
        schemaVersion: 1,
        modelVersion: version,
        effort: 'medium',
        furryMode: false,
        disableQuality: true,
        ucPreset: 'none',
        autoConvertWebp: false,
        autoConvertWebpQuality: 80,
      },
      job: {
        type: 'sd',
        backend: { type: 'NAI' },
        prompt: { type: 'text', text: 'a tree' },
        uc: '',
        steps: 28,
        sampling: 'k_euler_ancestral',
        promptGuidance: 5,
        cfgRescale: 0,
        characterPrompts: [],
        useCoords: false,
        noiseSchedule: 'karras',
        legacyPromptConditioning: false,
        normalizeStrength: true,
        varietyPlus: false,
        characterReferences: references.map((path) => ({
          path,
          info: 1,
          strength: 0.6,
          fidelity: 1,
          referenceType: 'character',
          enabled: true,
        })),
        vibes: vibes.map((path) => ({ path, info: 1, strength: 0.6 })),
      },
    },
  } as unknown as Task;
}

const services: TaskQueueService[] = [];
function start(value: Task) {
  const real = taskHandlers.find((candidate) => candidate.checkTask(value))!;
  const handler: TaskHandler = {
    createTimeEstimator: () => real.createTimeEstimator(),
    checkTask: (candidate) => real.checkTask(candidate),
    handleTask: (candidate, run, ctx) => real.handleTask(candidate, run, ctx),
    // Intentional pacing is verified separately; this fixture observes dispatch ownership.
    handleDelay: async () => {},
    getNumTries: (candidate) => real.getNumTries(candidate),
    getInfo: (candidate) => real.getInfo(candidate),
    calculateCost: (candidate) => real.calculateCost(candidate),
  };
  const service = new TaskQueueServiceRuntime([handler]);
  services.push(service);
  service.retryWait = async () => true;
  service.addTaskLocal(value.params, 1);
  const queued = service.queue.peek();
  const complete = jest.fn();
  service.addEventListener('complete', complete);
  service.runLocal();
  return { service, queued, complete };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}
const flush = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  saved.clear();
  getConfig.mockResolvedValue({ requestDelayMs: 0, requestDelayJitterMs: 0 });
  generateImage.mockImplementation(async (arg) => {
    saved.add(arg.outputFilePath);
  });
  encodeVibeImage.mockImplementation(async () => {});
  checkEncodedVibeImage.mockResolvedValue(false);
  reencodeReferenceForApi.mockImplementation(async (image) => `PNG:${image}`);
  onAddImage.mockImplementation(() => {});
  isPaidRisk.mockReturnValue(false);
  confirmAsync.mockResolvedValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  services.splice(0).forEach((service) => service.stop());
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('Stop while Anlas confirmation is pending prevents a new request after a late approval', async () => {
  const approval = deferred<boolean>();
  confirmAsync.mockReturnValueOnce(approval.promise);
  isPaidRisk.mockReturnValue(true);
  const f = start(task(ModelVersion.V5));
  await flush();
  expect(confirmAsync).toHaveBeenCalledTimes(1);
  f.service.stop();
  approval.resolve(true);
  await flush();
  expect(generateImage).not.toHaveBeenCalled();
  expect(f.queued.done).toBe(0);
  expect(f.service.pendingImageCount()).toBe(1);
  expect(approvePaidRisk).not.toHaveBeenCalled();
});

test('Stop during reference decode does not begin another decode or paid generation', async () => {
  const decoding = deferred<string>();
  reencodeReferenceForApi.mockReturnValueOnce(decoding.promise);
  const f = start(task(ModelVersion.V4_5, ['one', 'two']));
  await flush();
  expect(reencodeReferenceForApi).toHaveBeenCalledTimes(1);
  f.service.stop();
  decoding.resolve('PNG:one');
  await flush();
  expect(reencodeReferenceForApi).toHaveBeenCalledTimes(1);
  expect(generateImage).not.toHaveBeenCalled();
  expect(f.service.pendingImageCount()).toBe(1);
});

test('Stop during a persisted-encoding lookup prevents a new paid encoding', async () => {
  const lookup = deferred<boolean>();
  checkEncodedVibeImage.mockReturnValueOnce(lookup.promise);
  const f = start(task(ModelVersion.V4_5, [], ['vibe']));
  await flush();
  expect(checkEncodedVibeImage).toHaveBeenCalledTimes(1);
  f.service.stop();
  lookup.resolve(false);
  await flush();
  expect(encodeVibeImage).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
  expect(f.service.pendingImageCount()).toBe(1);
});

test('Stop waits for an already-dispatched encoding result but prevents the next generation', async () => {
  const encoding = deferred<void>();
  let encodingSaved = false;
  encodeVibeImage.mockImplementationOnce(async () => {
    await encoding.promise;
    encodingSaved = true;
  });
  const f = start(task(ModelVersion.V4_5, [], ['vibe']));
  await flush();
  expect(encodeVibeImage).toHaveBeenCalledTimes(1);
  f.service.stop();
  encoding.resolve();
  await flush();
  expect(encodingSaved).toBe(true);
  expect(generateImage).not.toHaveBeenCalled();
  expect(f.service.pendingImageCount()).toBe(1);
});

test('an uncertain encoding result after Stop still blocks an already-requested restart', async () => {
  const encoding = deferred<void>();
  encodeVibeImage.mockReturnValueOnce(encoding.promise);
  const f = start(task(ModelVersion.V4_5, [], ['vibe']));
  await flush();
  f.service.stop();
  f.service.runLocal();
  encoding.reject(
    Object.assign(new Error('paid encoding outcome unknown'), {
      retryable: false,
      outcomeUnknown: true,
    }),
  );
  await flush();
  expect(encodeVibeImage).toHaveBeenCalledTimes(1);
  expect(generateImage).not.toHaveBeenCalled();
  expect(f.service.pendingImageCount()).toBe(1);
  expect(f.service.isRunning()).toBe(false);
});

test('Stop after generation dispatch preserves the saved image and counts completion once', async () => {
  const generating = deferred<void>();
  generateImage.mockImplementationOnce(async (arg) => {
    await generating.promise;
    saved.add(arg.outputFilePath);
  });
  const f = start(task());
  await flush();
  expect(generateImage).toHaveBeenCalledTimes(1);
  f.service.stop();
  generating.resolve();
  await flush();
  expect(saved.size).toBe(1);
  expect(onAddImage).toHaveBeenCalledTimes(1);
  expect(f.queued.done).toBe(1);
  expect(f.complete).toHaveBeenCalledTimes(1);
  f.service.runLocal();
  await flush();
  expect(generateImage).toHaveBeenCalledTimes(1);
  expect(f.service.queue.isEmpty()).toBe(true);
});

test.each(['onComplete', 'onAddImage'])(
  'a post-save %s exception cannot replay the paid request and completion is counted',
  async (callback) => {
    const value = task();
    if (callback === 'onComplete')
      value.params.onComplete = () => {
        throw new Error('view disposed');
      };
    else
      onAddImage.mockImplementation(() => {
        throw new Error('scene view failed');
      });
    const f = start(value);
    await flush();
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(saved.size).toBe(1);
    expect(f.queued.done).toBe(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(onAddImage).toHaveBeenCalledTimes(1);
    expect(f.service.queue.isEmpty()).toBe(true);
  },
);

test('Medium snapshot eligibility uses its 14 steps while preserving the saved High preset and metadata', async () => {
  const value = task(ModelVersion.V5);
  (value.params.job as any).steps = 50;
  (value.params.job as any).sdstudioPromptSource = { text: 'source prompt' };
  const f = start(value);
  await flush();
  // Request precheck has one argument; the post-generation refresh has two.
  expect(
    refresh.mock.calls.filter((call: unknown[]) => call.length === 1),
  ).toHaveLength(1);
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({
      generationSettings: expect.objectContaining({ effort: 'medium' }),
      sdstudioMetadata: expect.objectContaining({
        generationSettings: expect.objectContaining({ effort: 'medium' }),
      }),
    }),
  );
  expect((value.params.job as any).steps).toBe(50);
  expect(f.queued.done).toBe(1);
});

test('a queued model is forwarded to vibe encoding even if global settings have changed', async () => {
  (getConfig as jest.Mock).mockResolvedValue({
    modelVersion: ModelVersion.V5,
    requestDelayMs: 0,
    requestDelayJitterMs: 0,
  });
  const value = task(ModelVersion.V4_5, [], ['vibe']);
  const real = taskHandlers.find((candidate) => candidate.checkTask(value))!;
  await real.handleTask(value, { stopped: false });
  expect(encodeVibeImage).toHaveBeenCalledWith(
    value.params.session,
    'vibe',
    1,
    undefined,
    ModelVersion.V4_5,
    expect.any(Function),
  );
});

test('a supported vibe list over the API maximum fails before any encoding without truncating user input', async () => {
  const paths = Array.from({ length: 17 }, (_, index) => `vibe-${index}`);
  const value = task(ModelVersion.V4_5, [], paths);
  const real = taskHandlers.find((candidate) => candidate.checkTask(value))!;
  await expect(
    real.handleTask(value, { stopped: false }),
  ).rejects.toMatchObject({ retryable: false });
  expect(encodeVibeImage).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
  expect((value.params.job as any).vibes.map((vibe: any) => vibe.path)).toEqual(
    paths,
  );
});

test('ignored vibes do not trip the maximum when a valid precise reference takes priority', async () => {
  const value = task(
    ModelVersion.V4_5,
    ['reference'],
    Array.from({ length: 17 }, (_, index) => `vibe-${index}`),
  );
  const real = taskHandlers.find((candidate) => candidate.checkTask(value))!;
  await expect(real.handleTask(value, { stopped: false })).resolves.toBe(true);
  expect(encodeVibeImage).not.toHaveBeenCalled();
  expect(generateImage).toHaveBeenCalledTimes(1);
});
