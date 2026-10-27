/**
 * Request lifetime is owned by completion/error or an explicit stop, never elapsed
 * time. These tests exercise the public queue/handler boundary with a deferred
 * paid transport. They retain intentional pacing in the separate timing suite.
 */
import type {
  Task,
  TaskAttemptContext,
  TaskHandler,
  TaskParam,
  TaskQueueService,
} from '../TaskQueueService';

const getConfig = jest.fn(async () => ({}));
const upscaleImage = jest.fn(async (_arg: unknown) => {});
const deleteFile = jest.fn(async (_path: string) => {});
const onAddImage = jest.fn();
jest.mock('..', () => ({
  backend: {
    getConfig,
    upscaleImage,
    deleteFile,
    readDataFile: jest.fn(async () => 'data:image/png;base64,image'),
    delegateComplete: jest.fn(async () => {}),
    delegateQueueSnapshot: jest.fn(async () => {}),
  },
  imageService: { onAddImage },
  isMobile: false,
  localAIService: {},
  promptService: {},
  sessionService: {},
  taskQueueService: {},
  workFlowService: {},
}));
jest.mock('../AppService', () => ({
  appState: { pushMessage: jest.fn(), pushDialog: jest.fn() },
}));
jest.mock('../PersistenceService', () => ({
  persistService: { write: jest.fn(async () => {}) },
}));
jest.mock('../PromptService', () => ({
  expandPieces: jest.fn(),
  lowerPromptNode: jest.fn(),
  toPARR: jest.fn(),
}));
jest.mock('../ImageService', () => ({
  dataUriToBase64: (data: string) => data.split(',')[1],
}));
jest.mock('../workflows/SDWorkFlow', () => ({
  prepareMirrorCanvas: jest.fn(),
}));
jest.mock('../../componenets/BrushTool', () => ({
  getImageDimensions: jest.fn(),
}));

// Load the subject after its mock fixtures have been initialized.
const { TaskQueueService: TaskQueueServiceRuntime } = jest.requireActual<
  typeof import('../TaskQueueService')
>('../TaskQueueService');
const { taskHandlers } =
  jest.requireActual<typeof import('../TaskHandlers')>('../TaskHandlers');

function handler(overrides: Partial<TaskHandler> = {}): TaskHandler {
  return {
    // Only the estimator collaborator is a test double; queue execution is real.
    createTimeEstimator: jest.fn(() => ({
      addSample: jest.fn(),
    })) as unknown as TaskHandler['createTimeEstimator'],
    checkTask: () => true,
    handleTask: jest.fn(async () => true),
    getNumTries: () => 1,
    handleDelay: jest.fn(async () => {}),
    getInfo: () => ({ name: 'generation', emoji: 'G' }),
    calculateCost: () => [],
    ...overrides,
  };
}

function param(): TaskParam {
  // Minimal project/scene fixture for the public queue contract, no real user data.
  return {
    session: { name: 'project' },
    scene: { name: 'scene', type: 'scene' },
    job: { type: 'sd' },
    outputPath: 'outs/project/scene',
  } as TaskParam;
}

async function flush() {
  await jest.advanceTimersByTimeAsync(0);
}

function cleanup(service: TaskQueueService) {
  service.stop();
  jest.clearAllTimers();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  getConfig.mockImplementation(async () => ({}));
  upscaleImage.mockImplementation(async () => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a slow paid result survives well beyond the old queue cutoff without abort or replay', async () => {
  let resolve!: (ok: boolean) => void;
  let context: TaskAttemptContext | undefined;
  const h = handler({
    handleTask: jest.fn((_task, _run, ctx) => {
      context = ctx;
      return new Promise<boolean>((_resolve) => {
        resolve = _resolve;
      });
    }),
  });
  const service = new TaskQueueServiceRuntime([h]);
  service.addTaskLocal(param(), 1);
  const running = service.runInternal({ stopped: false });
  await flush();
  let settled = false;
  const observedRun = running.then(() => {
    settled = true;

    return undefined;
  });
  await jest.advanceTimersByTimeAsync(60 * 60 * 1000);
  const beforeCompletion = {
    settled,
    aborted: context!.signal.aborted,
    calls: (h.handleTask as jest.Mock).mock.calls.length,
    remaining: service.pendingImageCount(),
  };
  resolve(true);
  await observedRun;
  expect(beforeCompletion).toEqual({
    settled: false,
    aborted: false,
    calls: 1,
    remaining: 1,
  });
  expect(service.queue.isEmpty()).toBe(true);
  expect(h.handleTask).toHaveBeenCalledTimes(1);
  cleanup(service);
});

test('stop and immediate restart wait for the in-flight result and never generate the same sample twice', async () => {
  const finish: Array<(ok: boolean) => void> = [];
  const h = handler({
    handleTask: jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish.push(resolve);
        }),
    ),
  });
  const service = new TaskQueueServiceRuntime([h]);
  service.addTaskLocal(param(), 1);
  service.runLocal();
  await flush();
  expect(h.handleTask).toHaveBeenCalledTimes(1);
  service.stop();
  expect(service.isRunning()).toBe(false);
  expect(service.hasPendingExecution()).toBe(true);
  service.runLocal();
  await flush();
  const callsBeforeFirstResult = (h.handleTask as jest.Mock).mock.calls.length;
  // Release any wrongly duplicated request too, so a failing RED leaves no work.
  finish.forEach((done) => done(true));
  await flush();
  const state = {
    calls: (h.handleTask as jest.Mock).mock.calls.length,
    remaining: service.pendingImageCount(),
    running: service.isRunning(),
  };
  cleanup(service);
  expect(callsBeforeFirstResult).toBe(1);
  expect(state).toEqual({ calls: 1, remaining: 0, running: false });
  expect(service.hasPendingExecution()).toBe(false);
});

test('an ambiguous paid outcome stops a pending restart and retains its task for review', async () => {
  let reject!: (error: Error) => void;
  const h = handler({
    getNumTries: () => 10,
    handleTask: jest.fn(
      () =>
        new Promise<boolean>((_resolve, _reject) => {
          reject = _reject;
        }),
    ),
  });
  const service = new TaskQueueServiceRuntime([h]);
  service.addTaskLocal(param(), 1);
  service.runLocal();
  await flush();
  service.stop();
  service.runLocal();
  await flush();
  reject(
    Object.assign(new Error('connection lost after dispatch'), {
      retryable: false,
      outcomeUnknown: true,
    }),
  );
  await flush();
  const state = {
    calls: (h.handleTask as jest.Mock).mock.calls.length,
    remaining: service.pendingImageCount(),
    running: service.isRunning(),
  };
  cleanup(service);
  expect(state).toEqual({ calls: 1, remaining: 1, running: false });
});

test('a successfully saved image is retained and announced when cancellation arrives after the save', async () => {
  const controller = new AbortController();
  upscaleImage.mockImplementation(async () => {
    controller.abort();
  });
  const task: Task = {
    id: 'saved-image',
    cls: 8,
    done: 0,
    total: 1,
    params: {
      ...param(),
      job: { type: 'upscale', backend: { type: 'NAI' }, image: 'image' },
    } as TaskParam,
  };
  const upscale = taskHandlers.find((candidate) => candidate.checkTask(task))!;
  const ctx: TaskAttemptContext = {
    attempt: 1,
    signal: controller.signal,
  };
  let failure: unknown;
  try {
    await upscale.handleTask(task, { stopped: false }, ctx);
  } catch (error) {
    failure = error;
  }
  expect({ failure, deleted: deleteFile.mock.calls }).toEqual({
    failure: undefined,
    deleted: [],
  });
  expect(onAddImage).toHaveBeenCalledTimes(1);
  expect(onAddImage.mock.calls[0][2]).toMatch(
    /^outs\/project\/scene\/.+\.png$/,
  );
});
