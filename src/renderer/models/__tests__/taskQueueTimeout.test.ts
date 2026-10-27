/**
 * 큐 요청 수명·재시도 대기 — 실제 완료 대기, 명시적 취소, 저장된 결과 보존, 실패 횟수 사다리 대기,
 * 2026-10-24: 유료 작업의 고정 종료 시각과 늦은 결과 삭제 정책을 제거한 계약을 검증한다.
 * 429 최소 60초. 요청 사이 지연(T3): 새 키 전달·옛 delayTime 환산(T3b)·큐 잔량 전달·재시도 지연 생략·긴 휴식.
 * 긴 휴식(T3b): 서비스 수준 카운터(실행을 넘어 이어짐·유휴 2분 재설정)·휴식 상태 노출.
 * T4: 재시도 횟수 10(상수)·연속 실패 3회 정지+확인 창·409 고정 30초+토스트·업스케일 타임아웃 안내·
 * 지연 대기 정지 가능·결과 불명 요청 보존과 정지.
 */
import type {
  TaskAttemptContext,
  TaskHandler,
  TaskQueueRun,
  TaskQueueService,
} from '../TaskQueueService';

const getConfig = jest.fn(async () => ({}));
const upscaleImage = jest.fn(async (_arg: any) => {});
const deleteFile = jest.fn(async (_path: string) => {});
const readDataFile = jest.fn(async () => 'data:image/png;base64,file-image');
const onAddImage = jest.fn();

jest.mock('..', () => ({
  backend: {
    getConfig,
    upscaleImage,
    deleteFile,
    readDataFile,
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
  dataUriToBase64: jest.fn((data: string) => data.split(',')[1]),
}));

jest.mock('../workflows/SDWorkFlow', () => ({
  prepareMirrorCanvas: jest.fn(),
}));

jest.mock('../../componenets/BrushTool', () => ({
  getImageDimensions: jest.fn(),
}));

// Load the subject after its mock fixtures have been initialized.
const { handleNAIDelay, TaskQueueService: TaskQueueServiceRuntime } =
  jest.requireActual<typeof import('../TaskQueueService')>(
    '../TaskQueueService',
  );
const { taskHandlers } =
  jest.requireActual<typeof import('../TaskHandlers')>('../TaskHandlers');
const {
  CONCURRENT_RETRY_WAIT_MS,
  CONSECUTIVE_FAILURE_STOP,
  NAI_MAX_TRIES,
  RequestTimeoutError,
  TASK_FAILURE_TEXT,
} = jest.requireActual<typeof import('../requestTiming')>('../requestTiming');
const { createNaiApiError, isNaiAuthError } = jest.requireActual<
  typeof import('../../backends/genVendors/naiErrors')
>('../../backends/genVendors/naiErrors');
const { appState } =
  jest.requireMock<typeof import('../AppService')>('../AppService');

const pushMessage = appState.pushMessage as jest.Mock;
const pushDialog = appState.pushDialog as jest.Mock;

function makeHandler(overrides: Partial<TaskHandler> = {}): TaskHandler {
  return {
    createTimeEstimator: jest.fn(() => ({ addSample: jest.fn() })) as any,
    checkTask: () => true,
    handleTask: jest.fn(async () => true),
    getNumTries: () => 1,
    handleDelay: jest.fn(async () => {}),
    getInfo: () => ({ name: 'test', emoji: 'T' }),
    calculateCost: () => [],
    ...overrides,
  };
}

function makeParam(project = 'project', delegated = false) {
  return {
    session: { name: project },
    scene: { name: 'scene', type: 'scene' },
    job: { type: 'sd' },
    outputPath: `outs/${project}/scene`,
    ...(delegated
      ? {
          delegation: {
            originWindowId: 2,
            taskId: `t-${project}`,
            sessionName: project,
            sceneName: 'scene',
            sceneType: 'scene',
          },
        }
      : {}),
  } as any;
}

const run = (): TaskQueueRun => ({ stopped: false });

// 재시도 대기를 실제로 기다리지 않고 기록만 한다.
function recordWaits(service: TaskQueueService): number[] {
  const waits: number[] = [];
  service.retryWait = jest.fn(async (ms: number) => {
    waits.push(ms);
    return true;
  });
  return waits;
}

function cleanup(service: TaskQueueService) {
  const s = service as any;
  if (s.logsSaveTimer) clearTimeout(s.logsSaveTimer);
  s.logsSaveTimer = null;
}

beforeEach(() => {
  getConfig.mockReset();
  getConfig.mockImplementation(async () => ({}));
  upscaleImage.mockReset();
  upscaleImage.mockImplementation(async () => {});
  deleteFile.mockReset();
  deleteFile.mockImplementation(async () => {});
  readDataFile.mockClear();
  onAddImage.mockClear();
  pushMessage.mockClear();
  pushDialog.mockClear();
  // 재시도 루프의 console.error/log 출력은 의도된 것 — 테스트 출력만 조용히.
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runAttempt — 요청의 실제 완료를 기다림', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('시도마다 추적 번호가 다르고 시도용 타이머를 만들지 않는다', async () => {
    const seen: number[] = [];
    const handler = makeHandler({
      handleTask: jest.fn(async (_task, _run, ctx) => {
        seen.push(ctx!.attempt);
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    await service.runAttempt(handler, {} as any, run());
    await service.runAttempt(handler, {} as any, run());
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('사용자 확인을 오래 기다려도 취소하거나 추가 요청을 만들지 않는다', async () => {
    let answer!: (ok: boolean) => void;
    let ctx: TaskAttemptContext | undefined;
    const handler = makeHandler({
      handleTask: jest.fn((_task, _run, context) => {
        ctx = context;
        return new Promise<boolean>((resolve) => {
          answer = resolve;
        });
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const pending = service.runAttempt(handler, {} as any, run());
    await jest.advanceTimersByTimeAsync(600000);
    expect(ctx!.signal.aborted).toBe(false);
    expect(handler.handleTask).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    answer(true);
    await expect(pending).resolves.toBe(true);
  });
});

describe('runInternal — 오류 재시도와 의도적인 대기', () => {
  test('요청 사이 지연 설정: 새 키를 넘기고, 새 키가 없으면 옛 delayTime 을 ×7.5·×1.5 로 환산', async () => {
    const handler = makeHandler();
    const service = new TaskQueueServiceRuntime([handler]);
    getConfig.mockImplementation(async () => ({}) as any);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(handler.handleDelay).toHaveBeenLastCalledWith(
      expect.anything(),
      0,
      { baseMs: 1500, jitterMs: 500 },
      1,
      expect.any(Function),
    );
    getConfig.mockImplementation(async () => ({ delayTime: 700 }) as any);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(handler.handleDelay).toHaveBeenLastCalledWith(
      expect.anything(),
      0,
      { baseMs: 5300, jitterMs: 1100 },
      1,
      expect.any(Function),
    );
    getConfig.mockImplementation(
      async () =>
        ({
          requestDelayMs: 6000,
          requestDelayJitterMs: 2000,
          delayTime: 1000,
        }) as any,
    );
    service.addTaskLocal(makeParam(), 3);
    await service.runInternal(run());
    expect(handler.handleDelay).toHaveBeenLastCalledWith(
      expect.anything(),
      0,
      { baseMs: 6000, jitterMs: 2000 },
      1,
      expect.any(Function),
    );
    cleanup(service);
  });

  test('handleDelay 에 넘기는 잔량 = 큐 안 모든 작업의 (total − done) 합(현재 작업 포함)', async () => {
    const pending: number[] = [];
    const handler = makeHandler({
      handleDelay: jest.fn(async (_t: any, _n: number, _d: any, p: number) => {
        pending.push(p);
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    service.addTaskLocal(makeParam(), 2);
    service.addTaskLocal(makeParam(), 3);
    expect(service.pendingImageCount()).toBe(5);
    await service.runInternal(run());
    expect(pending).toEqual([5, 4, 3, 2, 1]);
    expect(service.pendingImageCount()).toBe(0);
    cleanup(service);
  });

  test('잔량 계산은 오염된 total(NaN)을 세지 않는다', () => {
    const service = new TaskQueueServiceRuntime([makeHandler()]);
    service.addTaskLocal(makeParam(), 4);
    service.queue.peek().done = 1;
    service.addTaskLocal(makeParam(), 2);
    for (const t of service.queue) if (t && t.total === 2) t.total = NaN;
    expect(service.pendingImageCount()).toBe(3);
    cleanup(service);
  });

  test('긴 휴식: 성공 장수 카운터가 0 이 되면 완료 집계 뒤 2~4분 쉬고 카운터를 다시 채운다', async () => {
    const handler = makeHandler();
    const service = new TaskQueueServiceRuntime([handler]);
    const breaks: number[] = [];
    let doneAtBreak = -1;
    service.longBreakWait = jest.fn(async (ms: number) => {
      breaks.push(ms);
      doneAtBreak = service.statsAllTasks().done;
      return true;
    });
    service.addTaskLocal(makeParam(), 3);
    service.longBreakRemaining = 2;
    await service.runInternal(run());
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toBeGreaterThanOrEqual(120000);
    expect(breaks[0]).toBeLessThanOrEqual(240000);
    // 2장째 완료가 이미 집계된 뒤에 쉰다
    expect(doneAtBreak).toBe(2);
    // 휴식 뒤 300~399 로 다시 채우고, 3장째 성공으로 1 줄었다
    expect(service.longBreakRemaining).toBeGreaterThanOrEqual(299);
    expect(service.longBreakRemaining).toBeLessThanOrEqual(398);
    cleanup(service);
  });

  test('긴 휴식: 남은 예약이 없으면 쉬지 않고, 카운터는 0 이하로 남아 다음 실행 첫 성공 뒤 쉰다', async () => {
    const service = new TaskQueueServiceRuntime([makeHandler()]);
    service.longBreakWait = jest.fn(async () => true);
    service.addTaskLocal(makeParam(), 1);
    service.longBreakRemaining = 1;
    await service.runInternal(run());
    expect(service.longBreakWait).not.toHaveBeenCalled();
    expect(service.longBreakRemaining).toBe(0);
    // 곧바로(유휴 2분 미만) 다음 실행 — 첫 성공 뒤 남은 예약이 있으면 쉰다
    service.addTaskLocal(makeParam(), 2);
    await service.runInternal(run());
    expect(service.longBreakWait).toHaveBeenCalledTimes(1);
    cleanup(service);
  });

  test('재시도 가능한 실패 뒤 대기는 실패 횟수 사다리(±20%), 성공 뒤·마지막 시도 뒤에는 없음', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5); // 무작위 0
    const failures = [
      createNaiApiError(500, 'a'),
      new Error('Network request failed'),
      new RequestTimeoutError(120000),
      createNaiApiError(502, 'b'),
      createNaiApiError(503, 'c'),
      createNaiApiError(504, 'd'),
    ];
    const handler = makeHandler({
      getNumTries: () => 7,
      handleTask: jest.fn(async () => {
        const next = failures.shift();
        if (next) throw next;
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(waits).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
    // handleDelay 는 매 시도 앞에서 불리지만, 실제 지연은 첫 시도(numTry 0)에만(handleNAIDelay 가 재시도면 즉시 반환).
    expect(handler.handleDelay).toHaveBeenCalledTimes(7);
    expect(
      (handler.handleDelay as jest.Mock).mock.calls.map((c) => c[1]),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    cleanup(service);
  });

  test('429 는 최소 60초, 그 뒤 사다리가 60초를 넘으면 사다리', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999999); // +20%
    const failures = [
      createNaiApiError(429, 'Too many'),
      createNaiApiError(429, 'Too many'),
      createNaiApiError(429, 'Too many'),
      createNaiApiError(429, 'Too many'),
      createNaiApiError(429, 'Too many'),
    ];
    const handler = makeHandler({
      getNumTries: () => 6,
      handleTask: jest.fn(async () => {
        const next = failures.shift();
        if (next) throw next;
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(waits).toEqual([60000, 60000, 60000, 60000, 72000]);
    expect(
      (service as any).taskLogs.some((l: any) =>
        /요청 제한 \(429\) - 60초 대기 후 재시도/.test(l.message),
      ),
    ).toBe(true);
    cleanup(service);
  });

  test('요청 ID 에 429 가 섞인 5xx 는 429 대기를 쓰지 않는다', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    let first = true;
    const handler = makeHandler({
      getNumTries: () => 2,
      handleTask: jest.fn(async () => {
        if (first) {
          first = false;
          throw createNaiApiError(500, 'oops', 'ray-429-abc');
        }
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(waits).toEqual([5000]);
    cleanup(service);
  });

  test('재시도 불가 오류는 기다리지 않고 건너뛴다, 재시도 횟수는 핸들러 값 그대로', async () => {
    const nonRetryable = Object.assign(new Error('auth'), { retryable: false });
    const handler = makeHandler({
      getNumTries: () => 40,
      handleTask: jest.fn(async () => {
        throw nonRetryable;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(waits).toEqual([]);
    expect(handler.handleTask).toHaveBeenCalledTimes(1);
    expect(service.queue.isEmpty()).toBe(true);
    cleanup(service);

    // 계속 실패하면 정확히 getNumTries 회 시도하고, 대기는 시도 사이에만(횟수 − 1).
    const always = makeHandler({
      getNumTries: () => 40,
      handleTask: jest.fn(async () => {
        throw createNaiApiError(500, 'x');
      }),
    });
    const service2 = new TaskQueueServiceRuntime([always]);
    const waits2 = recordWaits(service2);
    service2.addTaskLocal(makeParam(), 1);
    await service2.runInternal(run());
    expect(always.handleTask).toHaveBeenCalledTimes(40);
    expect(waits2).toHaveLength(39);
    cleanup(service2);
  });

  test('재시도 대기 중 정지하면 다음 요청을 보내지 않는다', async () => {
    const cur = run();
    const handler = makeHandler({
      getNumTries: () => 5,
      handleTask: jest.fn(async () => {
        throw createNaiApiError(500, 'x');
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    service.retryWait = jest.fn(
      async (_ms: number, shouldStop: () => boolean) => {
        cur.stopped = true;
        return !shouldStop();
      },
    );
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(cur);
    expect(handler.handleTask).toHaveBeenCalledTimes(1);
    expect(service.retryWait).toHaveBeenCalledTimes(1);
    cleanup(service);
  });

  test('지연 대기 중 정지하면 요청을 보내지 않는다', async () => {
    const cur = run();
    const handler = makeHandler({
      handleDelay: jest.fn(async () => {
        cur.stopped = true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(cur);
    expect(handler.handleTask).not.toHaveBeenCalled();
    cleanup(service);
  });

  test('handleDelay 에 넘기는 shouldStop 은 실행의 정지 상태를 그대로 본다(T4)', async () => {
    const cur = run();
    const seen: boolean[] = [];
    const handler = makeHandler({
      handleDelay: jest.fn(
        async (
          _t: any,
          _n: number,
          _d: any,
          _p: number,
          shouldStop: () => boolean,
        ) => {
          seen.push(shouldStop());
          cur.stopped = true;
          seen.push(shouldStop());
        },
      ),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(cur);
    expect(seen).toEqual([false, true]);
    expect(handler.handleTask).not.toHaveBeenCalled();
    cleanup(service);
  });
});

describe('재시도 횟수·연속 실패 정지·409·업스케일 타임아웃(T4)', () => {
  test('생성·증강 핸들러는 최대 10회(상수), 업스케일·배경 제거는 1회', () => {
    expect(NAI_MAX_TRIES).toBe(10);
    const tries = (job: any, nodelay = false) => {
      const task = { params: { ...makeParam(), job, nodelay } } as any;
      return taskHandlers.find((h) => h.checkTask(task))!.getNumTries(task);
    };
    expect(tries({ type: 'sd' })).toBe(NAI_MAX_TRIES);
    expect(tries({ type: 'sd' }, true)).toBe(NAI_MAX_TRIES);
    expect(tries({ type: 'sd_inpaint' })).toBe(NAI_MAX_TRIES);
    expect(tries({ type: 'sd_i2i' })).toBe(NAI_MAX_TRIES);
    expect(tries({ type: 'augment', backend: { type: 'NAI' } })).toBe(
      NAI_MAX_TRIES,
    );
    expect(tries({ type: 'upscale', backend: { type: 'NAI' } })).toBe(1);
    expect(
      tries({ type: 'augment', backend: { type: 'SD' }, method: 'bg-removal' }),
    ).toBe(1);
  });

  test('로그의 시도 번호·건너뜀 문구는 시도 횟수에서 만든다', async () => {
    const handler = makeHandler({
      getNumTries: () => NAI_MAX_TRIES,
      handleTask: jest.fn(async () => {
        throw createNaiApiError(500, 'x');
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(handler.handleTask).toHaveBeenCalledTimes(NAI_MAX_TRIES);
    const messages = service.taskLogs.map((l) => l.message);
    expect(messages.some((m) => m.endsWith(' [10/10]'))).toBe(true);
    expect(messages).toContain('10회 재시도 실패 - 건너뜀');
    expect(service.consecutiveTaskFailures).toBe(1);
    cleanup(service);
  });

  test('재시도를 소진한 작업이 3개 연속이면 세 번째 작업을 큐에 남긴 채 정지하고 확인 창으로 알린다', async () => {
    const handler = makeHandler({
      getNumTries: () => 2,
      handleTask: jest.fn(async (task: any) => {
        throw createNaiApiError(503, `down-${task.params.session.name}`);
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    recordWaits(service);
    const cur = run();
    service.currentRun = cur;
    const events: string[] = [];
    service.addEventListener('stop', () => events.push('stop'));
    service.addEventListener('failure-stop', () => events.push('failure-stop'));
    for (const name of ['a', 'b', 'c', 'd'])
      service.addTaskLocal(makeParam(name), 1);
    await service.runInternal(cur);
    // a·b 는 건너뛰고, c 에서 정지 — c·d 는 큐에 남는다.
    expect(handler.handleTask).toHaveBeenCalledTimes(3 * 2);
    expect(cur.stopped).toBe(true);
    expect(service.currentRun).toBeUndefined();
    expect(service.queue.peek().params.session.name).toBe('c');
    expect(service.statsAllTasks()).toEqual({ done: 0, total: 2 });
    expect(events).toEqual(['stop', 'failure-stop']);
    expect(pushDialog).toHaveBeenCalledTimes(1);
    const dialog = pushDialog.mock.calls[0][0];
    expect(dialog.type).toBe('yes-only');
    expect(dialog.text).toBe(
      TASK_FAILURE_TEXT.consecutiveStop(
        createNaiApiError(503, 'down-c').message,
      ),
    );
    expect(dialog.text).toContain(
      `작업 ${CONSECUTIVE_FAILURE_STOP}개가 연속으로 실패해 예약을 중지했습니다.`,
    );
    expect(dialog.text).toContain(
      '마지막 오류: NovelAI 서버 오류 (503): down-c',
    );
    expect(
      service.taskLogs.some(
        (l) => l.level === 'error' && l.message.startsWith('작업 3개가'),
      ),
    ).toBe(true);
    // 정지와 함께 연속 수를 새로 센다.
    expect(service.consecutiveTaskFailures).toBe(0);
    cleanup(service);
  });

  test('인증 오류(401)는 첫 작업에서 재시도 없이 바로 정지하고 작업을 큐에 남긴 채 확인 창으로 알린다', async () => {
    const handler = makeHandler({
      getNumTries: () => NAI_MAX_TRIES,
      handleTask: jest.fn(async () => {
        throw createNaiApiError(
          401,
          JSON.stringify({ message: 'Invalid token' }),
        );
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    const cur = run();
    service.currentRun = cur;
    const events: string[] = [];
    let stopText = '';
    service.addEventListener('stop', () => events.push('stop'));
    service.addEventListener('failure-stop', (e: any) => {
      events.push('failure-stop');
      stopText = e.detail.text;
    });
    for (const name of ['a', 'b']) service.addTaskLocal(makeParam(name), 1);
    await service.runInternal(cur);
    expect(handler.handleTask).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(cur.stopped).toBe(true);
    expect(service.currentRun).toBeUndefined();
    expect(service.queue.peek().params.session.name).toBe('a');
    expect(service.statsAllTasks()).toEqual({ done: 0, total: 2 });
    expect(events).toEqual(['stop', 'failure-stop']);
    expect(pushDialog).toHaveBeenCalledTimes(1);
    const dialog = pushDialog.mock.calls[0][0];
    expect(dialog.type).toBe('yes-only');
    const { message } = createNaiApiError(
      401,
      JSON.stringify({ message: 'Invalid token' }),
    );
    expect(dialog.text).toBe(TASK_FAILURE_TEXT.authStop(message));
    expect(dialog.text).toBe(
      `로그인 인증 오류로 예약을 중지했습니다.\n토큰을 확인한 뒤 다시 시작해 주세요.\n${message}`,
    );
    expect(stopText).toBe(dialog.text);
    expect(service.taskLogs.some((l) => l.message.includes('건너뜀'))).toBe(
      false,
    );
    expect(service.consecutiveTaskFailures).toBe(0);
    cleanup(service);
  });

  test('403 도 인증 오류로 즉시 정지, 판정은 kind 우선·문자열 폴백 없음', async () => {
    expect(isNaiAuthError(createNaiApiError(403, 'Forbidden'))).toBe(true);
    expect(isNaiAuthError(createNaiApiError(402, 'Anlas'))).toBe(false);
    expect(isNaiAuthError(createNaiApiError(500, 'x'))).toBe(false);
    expect(isNaiAuthError({ status: 401 })).toBe(true);
    expect(isNaiAuthError({ kind: 'quota', status: 401 })).toBe(false);
    expect(isNaiAuthError(new Error('요청 ID 401'))).toBe(false);
    expect(isNaiAuthError(null)).toBe(false);
    const handler = makeHandler({
      getNumTries: () => 2,
      handleTask: jest.fn(async () => {
        throw createNaiApiError(403, 'Forbidden');
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    recordWaits(service);
    service.addTaskLocal(makeParam('a'), 1);
    await service.runInternal(run());
    expect(handler.handleTask).toHaveBeenCalledTimes(1);
    expect(service.queue.isEmpty()).toBe(false);
    expect(pushDialog).toHaveBeenCalledTimes(1);
    cleanup(service);
  });

  test('할당량 오류(402)는 종전대로 재시도 없이 건너뛰고 연속 실패로 센다(즉시 정지 아님)', async () => {
    const handler = makeHandler({
      getNumTries: () => NAI_MAX_TRIES,
      handleTask: jest.fn(async (task: any) => {
        if (task.params.session.name === 'a') {
          throw createNaiApiError(
            402,
            JSON.stringify({ message: 'Not enough Anlas' }),
          );
        }
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    recordWaits(service);
    for (const name of ['a', 'b']) service.addTaskLocal(makeParam(name), 1);
    await service.runInternal(run());
    expect(handler.handleTask).toHaveBeenCalledTimes(2); // a 1회(재시도 불가) + b 성공
    expect(pushDialog).not.toHaveBeenCalled();
    expect(service.queue.isEmpty()).toBe(true);
    expect(service.taskLogs.some((l) => l.message.includes('건너뜀'))).toBe(
      true,
    );
    cleanup(service);
  });

  test('할당량 오류(402)만 연속이면 종전대로 3개째에서 연속 실패 정지', async () => {
    const handler = makeHandler({
      getNumTries: () => NAI_MAX_TRIES,
      handleTask: jest.fn(async () => {
        throw createNaiApiError(
          402,
          JSON.stringify({ message: 'Not enough Anlas' }),
        );
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    recordWaits(service);
    for (const name of ['a', 'b', 'c'])
      service.addTaskLocal(makeParam(name), 1);
    await service.runInternal(run());
    expect(handler.handleTask).toHaveBeenCalledTimes(3);
    expect(pushDialog).toHaveBeenCalledTimes(1);
    expect(pushDialog.mock.calls[0][0].text).toContain(
      `작업 ${CONSECUTIVE_FAILURE_STOP}개가 연속으로 실패해 예약을 중지했습니다.`,
    );
    expect(service.queue.peek().params.session.name).toBe('c');
    cleanup(service);
  });

  test('작업이 하나라도 성공하면 연속 실패 수를 새로 센다', async () => {
    const fail = new Set(['a', 'b', 'd', 'e']);
    const handler = makeHandler({
      getNumTries: () => 1,
      handleTask: jest.fn(async (task: any) => {
        if (fail.has(task.params.session.name))
          throw createNaiApiError(500, 'x');
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    recordWaits(service);
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      service.addTaskLocal(makeParam(name), 1);
    await service.runInternal(run());
    expect(pushDialog).not.toHaveBeenCalled();
    expect(service.queue.isEmpty()).toBe(true);
    expect(service.consecutiveTaskFailures).toBe(2);
    cleanup(service);
  });

  test('사용자가 실행을 새로 시작하면(runLocal) 연속 실패 수를 새로 센다', async () => {
    const service = new TaskQueueServiceRuntime([makeHandler()]);
    service.consecutiveTaskFailures = 2;
    service.runLocal();
    expect(service.consecutiveTaskFailures).toBe(0);
    service.stop();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    cleanup(service);
  });

  test('409(이전 요청 처리 중)는 사다리 대신 고정 30초 뒤 재시도하고 안내 토스트를 띄운다', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.999999); // 사다리라면 +20% 가 붙는다
    const outcomes: (Error | null)[] = [
      createNaiApiError(
        409,
        JSON.stringify({ message: 'Concurrent generation is locked' }),
      ),
      createNaiApiError(409, ''),
      createNaiApiError(500, 'x'),
      null,
    ];
    const handler = makeHandler({
      getNumTries: () => NAI_MAX_TRIES,
      handleTask: jest.fn(async () => {
        const next = outcomes.shift();
        if (next) throw next;
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    // 409 두 번은 30초 고정, 그 뒤 5xx 는 실패 횟수(3회째) 사다리 20초 × 1.2
    expect(waits).toEqual([
      CONCURRENT_RETRY_WAIT_MS,
      CONCURRENT_RETRY_WAIT_MS,
      24000,
    ]);
    expect(pushMessage).toHaveBeenCalledTimes(2);
    expect(pushMessage).toHaveBeenCalledWith(
      TASK_FAILURE_TEXT.concurrentRetry,
      'info',
    );
    expect(TASK_FAILURE_TEXT.concurrentRetry).toBe(
      '서버가 이전 요청을 아직 처리 중입니다. 30초 후 다시 시도합니다.',
    );
    expect(
      service.taskLogs.some(
        (l) =>
          l.level === 'warn' &&
          l.message === '이전 요청 처리 중 (409) - 30초 대기 후 재시도 [1/10]',
      ),
    ).toBe(true);
    expect(service.queue.isEmpty()).toBe(true);
    cleanup(service);
  });

  test('429 는 409 분기와 섞이지 않는다(최소 60초, 토스트 없음)', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    let first = true;
    const handler = makeHandler({
      getNumTries: () => 2,
      handleTask: jest.fn(async () => {
        if (first) {
          first = false;
          throw createNaiApiError(429, 'Concurrent generation is locked');
        }
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(waits).toEqual([60000]);
    expect(pushMessage).not.toHaveBeenCalled();
    cleanup(service);
  });

  test('409 가 마지막 시도면 기다리지도 토스트를 띄우지도 않고 건너뛴다', async () => {
    const handler = makeHandler({
      getNumTries: () => 1,
      handleTask: jest.fn(async () => {
        throw createNaiApiError(409, '');
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const waits = recordWaits(service);
    service.addTaskLocal(makeParam(), 1);
    await service.runInternal(run());
    expect(waits).toEqual([]);
    expect(pushMessage).not.toHaveBeenCalled();
    expect(service.queue.isEmpty()).toBe(true);
    cleanup(service);
  });

  test('업스케일 결과가 불명확하면 다시 보내지 않고 작업을 보존해 확인 창으로 알린다', async () => {
    const upscale = taskHandlers.find((h) =>
      h.checkTask({
        params: { job: { type: 'upscale', backend: { type: 'NAI' } } },
      } as any),
    )!;
    getConfig.mockImplementation(
      async () => ({ requestDelayMs: 0, requestDelayJitterMs: 0 }) as any,
    );
    const failure = Object.assign(new Error('connection lost after dispatch'), {
      retryable: false,
      outcomeUnknown: true,
    });
    upscaleImage.mockImplementation(async () => {
      throw failure;
    });
    const service = new TaskQueueServiceRuntime([upscale]);
    const waits = recordWaits(service);
    const errors: string[] = [];
    service.addEventListener('error', (e: any) => errors.push(e.detail.error));
    service.addTaskLocal(
      {
        ...makeParam(),
        job: { type: 'upscale', backend: { type: 'NAI' }, image: 'source' },
      } as any,
      1,
    );
    await service.runInternal(run());
    expect(upscaleImage).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
    expect(pushDialog).toHaveBeenCalledWith({
      type: 'yes-only',
      text: TASK_FAILURE_TEXT.unknownOutcomeStop(failure.message),
    });
    expect(errors).toContain(failure.message);
    expect(service.queue.isEmpty()).toBe(false);
    expect(service.pendingImageCount()).toBe(1);
    cleanup(service);
  });

  test('업스케일의 타임아웃이 아닌 실패는 오류 메시지 그대로(안내 토스트 없음)', async () => {
    const upscale = taskHandlers.find((h) =>
      h.checkTask({
        params: { job: { type: 'upscale', backend: { type: 'NAI' } } },
      } as any),
    )!;
    getConfig.mockImplementation(
      async () => ({ requestDelayMs: 0, requestDelayJitterMs: 0 }) as any,
    );
    upscaleImage.mockImplementation(async () => {
      throw createNaiApiError(500, 'boom');
    });
    const service = new TaskQueueServiceRuntime([upscale]);
    recordWaits(service);
    service.addTaskLocal(
      {
        ...makeParam(),
        job: { type: 'upscale', backend: { type: 'NAI' }, image: 'source' },
      } as any,
      1,
    );
    await service.runInternal(run());
    expect(pushMessage).not.toHaveBeenCalled();
    expect(
      service.taskLogs.some((l) =>
        l.message.startsWith('NovelAI 서버 오류 (500): boom'),
      ),
    ).toBe(true);
    cleanup(service);
  });
});

describe('긴 휴식 카운터 — 실행을 넘어 이어짐(T3b)', () => {
  let now = 1_000_000_000;
  beforeEach(() => {
    now = 1_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  // 성공 수를 세는 핸들러 + 휴식 때의 누적 성공 수 기록.
  function counting() {
    let successes = 0;
    const handler = makeHandler({
      handleTask: jest.fn(async () => {
        successes++;
        now += 1000;
        return true;
      }),
    });
    const service = new TaskQueueServiceRuntime([handler]);
    const breakAt: number[] = [];
    service.longBreakWait = jest.fn(async (ms: number) => {
      breakAt.push(successes);
      now += ms;
      return true;
    });
    return { service, breakAt, successes: () => successes };
  }

  test('10개 프로젝트 × 100장(절반은 보조 창 위임)을 한 실행에서 — 300~399장째마다 쉰다', async () => {
    const { service, breakAt, successes } = counting();
    for (let i = 0; i < 10; i++)
      service.addTaskLocal(makeParam(`p${i}`, i % 2 === 1), 100);
    await service.runInternal(run());
    expect(successes()).toBe(1000);
    expect(breakAt.length).toBeGreaterThanOrEqual(2);
    expect(breakAt[0]).toBeGreaterThanOrEqual(300);
    expect(breakAt[0]).toBeLessThanOrEqual(399);
    for (let k = 1; k < breakAt.length; k++) {
      const gap = breakAt[k] - breakAt[k - 1];
      expect(gap).toBeGreaterThanOrEqual(300);
      expect(gap).toBeLessThanOrEqual(399);
    }
    cleanup(service);
  });

  test('150장 → 유휴 10초 → 200장: 카운터가 이어져 두 번째 실행 중(누적 300장째) 쉰다', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // 카운터 300
    const { service, breakAt } = counting();
    expect(service.longBreakRemaining).toBe(300);
    service.addTaskLocal(makeParam('a'), 150);
    await service.runInternal(run());
    expect(breakAt).toEqual([]);
    expect(service.longBreakRemaining).toBe(150);
    now += 10_000;
    service.addTaskLocal(makeParam('b'), 200);
    await service.runInternal(run());
    expect(breakAt).toEqual([300]);
    cleanup(service);
  });

  test('150장 → 유휴 3분 → 200장: 유휴가 휴식 역할 — 카운터를 새로 세어 두 번째 실행에서는 쉬지 않는다', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0); // 카운터 300
    const { service, breakAt } = counting();
    service.addTaskLocal(makeParam('a'), 150);
    await service.runInternal(run());
    expect(service.longBreakRemaining).toBe(150);
    now += 3 * 60_000;
    service.addTaskLocal(makeParam('b'), 200);
    await service.runInternal(run());
    expect(breakAt).toEqual([]);
    expect(service.longBreakRemaining).toBe(100);
    cleanup(service);
  });

  test('직전 실행 루프가 아직 돌고 있으면(정지 뒤 요청 마무리) 유휴로 보지 않는다', async () => {
    const service = new TaskQueueServiceRuntime([makeHandler()]);
    service.lastRunEndedAt = now - 10 * 60_000;
    service.longBreakRemaining = 5;
    (service as any).activeRunLoops = 1;
    await service.runInternal(run()); // 빈 큐
    expect(service.longBreakRemaining).toBe(5);
    expect(service.lastRunEndedAt).toBe(now);
    cleanup(service);
  });

  test('휴식 상태: isLongBreak·longBreakUntil·progress 이벤트, 끝나면 0 으로 돌아가고 사이클 시작을 다시 찍는다', async () => {
    const service = new TaskQueueServiceRuntime([makeHandler()]);
    let progress = 0;
    // progress 이벤트마다 휴식 여부를 적어 둔다 — 휴식 시작(true)과 끝(그 뒤 false)이 모두 알려져야 한다.
    const restAtProgress: boolean[] = [];
    service.addEventListener('progress', () => {
      progress++;
      restAtProgress.push(service.isLongBreak());
    });
    let seen:
      | {
          rest: boolean;
          until: number;
          startedAt: number;
          progressAtStart: number;
        }
      | undefined;
    service.longBreakWait = jest.fn(async (ms: number) => {
      seen = {
        rest: service.isLongBreak(),
        until: service.longBreakUntil,
        startedAt: service.longBreakStartedAt,
        progressAtStart: progress,
      };
      now += ms;
      return true;
    });
    service.addTaskLocal(makeParam(), 2);
    service.longBreakRemaining = 1;
    expect(service.isLongBreak()).toBe(false);
    const progressBefore = () => progress;
    await service.runInternal(run());
    expect(seen!.rest).toBe(true);
    expect(seen!.startedAt).toBe(1_000_000_000);
    expect(seen!.until - seen!.startedAt).toBeGreaterThanOrEqual(120000);
    expect(seen!.until - seen!.startedAt).toBeLessThanOrEqual(240000);
    expect(seen!.progressAtStart).toBeGreaterThan(0);
    expect(progressBefore()).toBeGreaterThan(seen!.progressAtStart);
    // 휴식 시작 직전 마지막 progress 는 휴식 중(true), 그 바로 다음 progress 는 휴식 끝(false).
    expect(restAtProgress[seen!.progressAtStart - 1]).toBe(true);
    expect(restAtProgress[seen!.progressAtStart]).toBe(false);
    expect(service.isLongBreak()).toBe(false);
    expect(service.longBreakUntil).toBe(0);
    expect(service.longBreakStartedAt).toBe(0);
    expect(service.progressCycleStartedAt).toBeGreaterThanOrEqual(seen!.until);
    cleanup(service);
  });

  test('휴식 중 정지하면 표시가 바로 꺼지고, 휴식에 들어갔으므로 카운터를 새로 센다', async () => {
    const service = new TaskQueueServiceRuntime([makeHandler()]);
    const cur = run();
    service.currentRun = cur;
    let restAfterStop: boolean | undefined;
    service.longBreakWait = jest.fn(
      async (_ms: number, shouldStop: () => boolean) => {
        expect(service.isLongBreak()).toBe(true);
        service.stop();
        restAfterStop = service.isLongBreak();
        return !shouldStop();
      },
    );
    service.addTaskLocal(makeParam(), 3);
    service.longBreakRemaining = 1;
    await service.runInternal(cur);
    expect(restAfterStop).toBe(false);
    expect(service.longBreakUntil).toBe(0);
    // 사람이 직접 정지 = 끝까지 쉰 것과 같이 취급 → 300~399 로 재설정(정지 뒤 추가 성공 없음)
    expect(service.longBreakRemaining).toBeGreaterThanOrEqual(300);
    expect(service.longBreakRemaining).toBeLessThanOrEqual(399);
    cleanup(service);
  });
});

describe('handleNAIDelay — 첫 시도만 대기, 재시도는 생략, 정지하면 즉시 끝남(T4)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const never = () => false;

  test('재시도(numTry ≥ 1)는 난수도 타이머도 쓰지 않고 즉시 끝난다', async () => {
    const rand = jest.fn(() => 0.5);
    const settings = { baseMs: 10000, jitterMs: 5000 };
    await expect(
      handleNAIDelay(1, false, settings, 1000, never, rand),
    ).resolves.toBe(0);
    await expect(
      handleNAIDelay(9, true, settings, 1000, never, rand),
    ).resolves.toBe(0);
    expect(rand).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('첫 시도는 계산한 만큼 기다린다(일반 큐 급등 포함)', async () => {
    // 무작위 폭 0 · 급등(0.01 < 2%) · 배수 ×1.5 → 4000 × 1.5 = 6000
    const values = [0.5, 0.01, 0];
    let k = 0;
    let waited: number | undefined;
    const delay = handleNAIDelay(
      0,
      false,
      { baseMs: 4000, jitterMs: 1000 },
      1000,
      never,
      () => values[k++],
    ).then((v) => {
      waited = v;

      return undefined;
    });
    await flush();
    await jest.advanceTimersByTimeAsync(5999);
    expect(waited).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    await delay;
    expect(waited).toBe(6000);
  });

  test('빠른 생성은 급등 없음, 소량 예약은 1초로 완화', async () => {
    let waited: number | undefined;
    const fastDelay = handleNAIDelay(
      0,
      true,
      { baseMs: 4000, jitterMs: 0 },
      1000,
      never,
      () => 0,
    ).then((v) => {
      waited = v;

      return undefined;
    });
    await flush();
    await jest.advanceTimersByTimeAsync(4000);
    await flush();
    await fastDelay;
    expect(waited).toBe(4000);
    waited = undefined;
    const smallDelay = handleNAIDelay(
      0,
      false,
      { baseMs: 4000, jitterMs: 0 },
      20,
      never,
      () => 0,
    ).then((v) => {
      waited = v;

      return undefined;
    });
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    await flush();
    await smallDelay;
    expect(waited).toBe(1000);
  });

  test('지연 대기 중 정지하면 남은 대기를 버리고 바로 끝난다', async () => {
    let stopped = false;
    let finished = false;
    const delay = handleNAIDelay(
      0,
      false,
      { baseMs: 10000, jitterMs: 0 },
      1000,
      () => stopped,
      () => 0.5,
    ).then(() => {
      finished = true;

      return undefined;
    });
    await flush();
    await jest.advanceTimersByTimeAsync(1000);
    expect(finished).toBe(false);
    stopped = true;
    // 폴링 간격(250ms) 안에 끝난다 — 남은 9초를 기다리지 않는다.
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    await delay;
    expect(finished).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('실제 핸들러(업스케일)도 재시도에는 기다리지 않는다', async () => {
    const task = {
      params: {
        ...makeParam(),
        job: { type: 'upscale', backend: { type: 'NAI' } },
      },
    } as any;
    const handler = taskHandlers.find((h) => h.checkTask(task))!;
    let finished = false;
    const delay = handler
      .handleDelay(task, 1, { baseMs: 10000, jitterMs: 0 }, 1000, never)
      .then(() => {
        finished = true;

        return undefined;
      });
    await flush();
    await delay;
    expect(finished).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('실제 핸들러(생성)는 shouldStop 을 넘겨 정지 시 대기를 끝낸다', async () => {
    const task = { params: { ...makeParam(), job: { type: 'sd' } } } as any;
    const handler = taskHandlers.find((h) => h.checkTask(task))!;
    let stopped = false;
    let finished = false;
    const delay = handler
      .handleDelay(task, 0, { baseMs: 10000, jitterMs: 0 }, 1000, () => stopped)
      .then(() => {
        finished = true;

        return undefined;
      });
    await flush();
    await jest.advanceTimersByTimeAsync(500);
    expect(finished).toBe(false);
    stopped = true;
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    await delay;
    expect(finished).toBe(true);
  });
});

describe('핸들러 — 요청 옵션 전달과 저장된 결과 보존(업스케일 핸들러)', () => {
  function upscaleTask() {
    return {
      params: {
        ...makeParam(),
        job: {
          type: 'upscale',
          backend: { type: 'NAI' },
          image: 'source',
          width: 832,
          height: 1216,
          resolution: '832x1216',
        },
      },
    } as any;
  }
  function ctxWith(controller: AbortController): TaskAttemptContext {
    return {
      attempt: 1,
      signal: controller.signal,
    };
  }

  test('시도의 명시적 취소 signal 을 backend 요청에 넘긴다', async () => {
    const task = upscaleTask();
    const handler = taskHandlers.find((h) => h.checkTask(task))!;
    const controller = new AbortController();
    const ctx = ctxWith(controller);
    await handler.handleTask(task, {} as any, ctx);
    const arg = (upscaleImage.mock.calls as any[][])[0][0];
    expect(arg.request).toEqual({ signal: controller.signal });
    expect(onAddImage).toHaveBeenCalledTimes(1);
  });

  test('backend 저장 직후 취소가 와도 파일을 보존하고 씬에 추가한다', async () => {
    const task = upscaleTask();
    const handler = taskHandlers.find((h) => h.checkTask(task))!;
    const controller = new AbortController();
    upscaleImage.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(
      handler.handleTask(task, {} as any, ctxWith(controller)),
    ).resolves.toBe(true);
    const arg = (upscaleImage.mock.calls as any[][])[0][0];
    expect(deleteFile).not.toHaveBeenCalled();
    expect(onAddImage).toHaveBeenCalledWith(
      task.params.session,
      task.params.scene.name,
      arg.outputFilePath,
    );
  });

  test('이미 폐기된 시도는 요청을 보내지 않는다', async () => {
    const task = upscaleTask();
    const handler = taskHandlers.find((h) => h.checkTask(task))!;
    const controller = new AbortController();
    controller.abort();
    await expect(
      handler.handleTask(task, {} as any, ctxWith(controller)),
    ).rejects.toThrow();
    expect(upscaleImage).not.toHaveBeenCalled();
  });

  test('문맥이 없으면(구 호출부) 요청 옵션 없이 종전대로', async () => {
    const task = upscaleTask();
    const handler = taskHandlers.find((h) => h.checkTask(task))!;
    await handler.handleTask(task, {} as any);
    const arg = (upscaleImage.mock.calls as any[][])[0][0];
    expect(arg.request).toBeUndefined();
  });
});
