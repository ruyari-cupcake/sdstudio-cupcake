/** Behavior at the real task handler boundary; no paid API is called. */
import type { ModelVersion } from '../../backends/imageGen';
import type { Task, TaskQueueRun } from '../TaskQueueService';

const generateImage = jest.fn(async (_arg: unknown) => {});
const encodeVibeImage = jest.fn(async () => {});
const checkEncodedVibeImage = jest.fn(async () => false);
const fetchEncodedVibeImage = jest.fn(
  async () => 'data:application/octet-stream;base64,ENCODED',
);
const fetchReferenceImage = jest.fn(
  async (_session: unknown, path: string) => `data:image/png;base64,${path}`,
);
const reencodeReferenceForApi = jest.fn(
  async (value: string) => `JPEG:${value}`,
);
const getConfig = jest.fn(async () => ({}));
const refresh = jest.fn(async () => ({
  opusSubscribed: true,
  percent: 100,
  isNegative: false,
}));

jest.mock('..', () => ({
  backend: { getConfig, generateImage },
  imageService: {
    encodeVibeImage,
    checkEncodedVibeImage,
    fetchEncodedVibeImage,
    fetchReferenceImage,
    reencodeReferenceForApi,
    onAddImage: jest.fn(),
  },
  opusUsageService: {
    refresh,
    takeLowWarning: () => false,
    isPaidRisk: () => false,
    hasSessionPaidApproval: () => true,
  },
  isMobile: false,
  localAIService: {},
  loginService: {},
  promptService: {},
  sessionService: {},
  taskQueueService: {},
  workFlowService: {},
}));
jest.mock('../AppService', () => ({
  appState: { pushMessage: jest.fn(), pushDialog: jest.fn() },
}));
jest.mock('../PersistenceService', () => ({ persistService: {} }));
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
const { ModelVersion: ModelVersionRuntime, Resolution } = jest.requireActual<
  typeof import('../../backends/imageGen')
>('../../backends/imageGen');
const { taskHandlers } =
  jest.requireActual<typeof import('../TaskHandlers')>('../TaskHandlers');

function task(
  version: ModelVersion,
  references: string[] = [],
  vibes: string[] = [],
): Task {
  // The handler only reads these project/scene members; production services are collaborators.
  return {
    id: 'resource-task',
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
      generationSnapshot: {
        schemaVersion: 1,
        modelVersion: version,
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
const handle = (value: Task, run: TaskQueueRun) =>
  taskHandlers
    .find((candidate) => candidate.checkTask(value))!
    .handleTask(value, run);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test.each([ModelVersionRuntime.V5, ModelVersionRuntime.V5Curated])(
  '%s never reads or pays to encode unsupported saved reference/vibe inputs',
  async (version) => {
    await handle(task(version, ['ref'], ['vibe']), { stopped: false });
    expect(fetchReferenceImage).not.toHaveBeenCalled();
    expect(encodeVibeImage).not.toHaveBeenCalled();
    expect(checkEncodedVibeImage).not.toHaveBeenCalled();
    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        characterReferences: [],
        vibes: [],
      }),
    );
  },
);

test('an empty prompt is not silently replaced with an unrelated subject', async () => {
  const value = task(ModelVersionRuntime.V4_5);
  value.params.job = {
    ...value.params.job,
    prompt: { type: 'text', text: '' },
  } as typeof value.params.job;
  await handle(value, { stopped: false });
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({ prompt: '' }),
  );
});

test('V4 does not decode unsupported reference images', async () => {
  await handle(task(ModelVersionRuntime.V4, ['ref']), { stopped: false });
  expect(fetchReferenceImage).not.toHaveBeenCalled();
  expect(reencodeReferenceForApi).not.toHaveBeenCalled();
});

test('V4.5 prepares precise references first and skips the incompatible paid vibe encoding', async () => {
  await handle(task(ModelVersionRuntime.V4_5, ['ref'], ['vibe']), {
    stopped: false,
  });
  expect(reencodeReferenceForApi).toHaveBeenCalledTimes(1);
  expect(encodeVibeImage).not.toHaveBeenCalled();
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({
      characterReferences: [expect.objectContaining({ image: 'JPEG:ref' })],
      vibes: [],
    }),
  );
});

test('same-project scene batches retain only active references and reuse identical consecutive inputs', async () => {
  const run: TaskQueueRun = { stopped: false };
  const sceneCount = 32;
  for (let i = 0; i < sceneCount; i += 1) {
    await handle(task(ModelVersionRuntime.V4_5, [`ref-${i}`]), run);
  }
  await handle(task(ModelVersionRuntime.V4_5, ['ref-31']), run);
  expect([...run.cachedReferences!.keys()]).toEqual(['ref-31']);
  expect(reencodeReferenceForApi).toHaveBeenCalledTimes(sceneCount);
});

test('same-project scene batches retain only active vibes without clearing persisted encodings', async () => {
  const run: TaskQueueRun = { stopped: false };
  const sceneCount = 32;
  for (let i = 0; i < sceneCount; i += 1) {
    await handle(task(ModelVersionRuntime.V4_5, [], [`vibe-${i}`]), run);
  }
  await handle(task(ModelVersionRuntime.V4_5, [], ['vibe-31']), run);
  expect([...run.cachedVibes!.keys()]).toEqual(['vibe-31:1']);
  expect(encodeVibeImage).toHaveBeenCalledTimes(sceneCount);
});

test('ambiguous paid encoding failure is propagated before any generation request', async () => {
  const error = Object.assign(
    new Error('response lost after encoding dispatch'),
    {
      retryable: false,
      outcomeUnknown: true,
    },
  );
  encodeVibeImage.mockRejectedValueOnce(error);
  await expect(
    handle(task(ModelVersionRuntime.V4_5, [], ['vibe']), { stopped: false }),
  ).rejects.toBe(error);
  expect(generateImage).not.toHaveBeenCalled();
});

test('reference decode peak is one active image while all inputs reach the request', async () => {
  let active = 0;
  let peak = 0;
  reencodeReferenceForApi.mockImplementation(async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    return `JPEG:${value}`;
  });
  await handle(
    task(ModelVersionRuntime.V4_5, ['one', 'two', 'three', 'four']),
    {
      stopped: false,
    },
  );
  expect(peak).toBe(1);
  expect(generateImage).toHaveBeenCalledWith(
    expect.objectContaining({
      characterReferences: [
        expect.objectContaining({ image: 'JPEG:one' }),
        expect.objectContaining({ image: 'JPEG:two' }),
        expect.objectContaining({ image: 'JPEG:three' }),
        expect.objectContaining({ image: 'JPEG:four' }),
      ],
    }),
  );
});
