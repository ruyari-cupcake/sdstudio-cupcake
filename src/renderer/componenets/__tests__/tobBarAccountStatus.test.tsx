import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { OpusUsageStatus } from '../../backends/imageGen';
import {
  backend,
  imageService,
  loginService,
  opusUsageService,
  taskQueueService,
} from '../../models';
import TobBar from '../TobBar';

jest.mock('../../models', () => {
  const serviceModule = jest.requireActual<
    typeof import('../../models/OpusUsageService')
  >('../../models/OpusUsageService');
  const getStatus = jest.fn<Promise<OpusUsageStatus>, [{ force?: boolean }?]>();
  return {
    backend: {
      getRemainCredits: jest.fn<Promise<number>, [{ force?: boolean }?]>(),
      getOpusUsageStatus: getStatus,
      getConfig: jest.fn(async () => ({ multiTokenRotateWarningPercent: 10 })),
    },
    loginService: Object.assign(new EventTarget(), {
      loggedIn: true,
      activeProfileId: 'first',
      listTokenProfiles: jest.fn(() => []),
      loadTokenProfiles: jest.fn(async () => undefined),
      refresh: jest.fn(async () => 'valid' as const),
    }),
    opusUsageService: new serviceModule.OpusUsageService({
      getOpusUsageStatus: getStatus,
    }),
    taskQueueService: new EventTarget(),
    imageService: new EventTarget(),
    sessionService: new EventTarget(),
    isMobile: false,
  };
});
jest.mock('../../models/AppService', () => ({
  appState: {
    uiLayoutTemplate: 'classic',
    uiToolbar: { classic: false },
    incrementModalOverlay: jest.fn(),
    decrementModalOverlay: jest.fn(),
    pushMessage: jest.fn(),
  },
}));
jest.mock('../../models/layoutTemplates', () => ({
  resolveLayout: () => ({
    sessionSelectTop: false,
    projectSidebar: true,
    projectStrip: false,
  }),
}));
jest.mock('../../models/BackStackService', () => ({
  backStackService: { push: () => ({ remove: jest.fn() }) },
}));
jest.mock('../FloatView', () => ({ FloatView: () => null }));
jest.mock('../ConfigScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../SessionSelect', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../ModelFamilySwitch', () => ({
  __esModule: true,
  default: () => null,
}));

interface LoginFixture extends EventTarget {
  loggedIn: boolean;
  activeProfileId: string | undefined;
  refresh: jest.Mock<Promise<'valid'>, []>;
}

const getRemainCredits = jest.mocked(backend.getRemainCredits);
const getOpusUsageStatus = jest.mocked(backend.getOpusUsageStatus);
const usage = opusUsageService;
const login = loginService as unknown as LoginFixture;
const tasks = taskQueueService;
const images = imageService;

function deferred<T>() {
  let fulfill!: (value: T | PromiseLike<T>) => void;
  let fail!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    fulfill = resolve;
    fail = reject;
  });
  return { promise, resolve: fulfill, reject: fail };
}

function quota(percent: number): OpusUsageStatus {
  return {
    percent,
    opusSubscribed: true,
    isNegative: false,
    timeUntilNextPercent: 30,
  };
}

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
let root: Root;
let container: HTMLDivElement;
let previousElectron: PropertyDescriptor | undefined;
const invoke = jest.fn(async (_channel: string) => false);

beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

beforeEach(() => {
  jest.clearAllMocks();
  getRemainCredits.mockReset().mockResolvedValue(1200);
  getOpusUsageStatus.mockReset().mockResolvedValue(quota(91));
  login.loggedIn = true;
  login.activeProfileId = 'first';
  usage.clear();
  previousElectron = Object.getOwnPropertyDescriptor(window, 'electron');
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { ipcRenderer: { invoke } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (previousElectron) {
    Object.defineProperty(window, 'electron', previousElectron);
  } else {
    Reflect.deleteProperty(window, 'electron');
  }
  jest.useRealTimers();
});

async function renderBar() {
  await act(async () => root.render(<TobBar />));
}

function balance() {
  const node = container.querySelector<HTMLElement>('[aria-label^="Anlas "]');
  if (!node) throw new Error('The title bar does not expose its Anlas balance');
  return node;
}

function quotaButton() {
  const node = container.querySelector<HTMLButtonElement>(
    'button[aria-label^="무료 생성 할당량"]',
  );
  if (!node)
    throw new Error('The title bar does not expose its generation quota');
  return node;
}

test('pending Anlas is unknown while the independent existing quota owner can finish', async () => {
  const pending = deferred<number>();
  getRemainCredits.mockReturnValueOnce(pending.promise);
  await renderBar();

  expect(balance().textContent).toContain('—');
  expect(balance().getAttribute('aria-label')).not.toBe('Anlas 0');
  expect(balance().title).toContain('확인 중');
  expect(quotaButton().getAttribute('aria-label')).toContain('91%');

  await act(async () => pending.resolve(0));
  expect(balance().getAttribute('aria-label')).toBe('Anlas 0');
});

test('a confirmed zero balance and zero quota stay numeric zero', async () => {
  getRemainCredits.mockResolvedValue(0);
  getOpusUsageStatus.mockResolvedValue(quota(0));
  await renderBar();

  expect(balance().getAttribute('aria-label')).toBe('Anlas 0');
  expect(quotaButton().getAttribute('aria-label')).toContain('0%');
  expect(
    quotaButton()
      .querySelector('[role="progressbar"]')
      ?.getAttribute('aria-valuenow'),
  ).toBe('0');
});

test('an Anlas lookup failure does not invent zero or prevent a quota update', async () => {
  getRemainCredits.mockRejectedValueOnce(new Error('offline'));
  getOpusUsageStatus.mockResolvedValue(quota(88));
  await renderBar();

  expect(balance().textContent).toContain('—');
  expect(balance().title).toContain('조회 실패');
  expect(quotaButton().getAttribute('aria-label')).toContain('88%');
  expect(login.refresh).toHaveBeenCalledTimes(1);
});

test('an automatic profile change immediately clears the old balance and rejects late old-account results', async () => {
  await renderBar();
  const oldLookup = deferred<number>();
  const newLookup = deferred<number>();
  getRemainCredits
    .mockReturnValueOnce(oldLookup.promise)
    .mockReturnValueOnce(newLookup.promise);

  await act(async () => {
    tasks.dispatchEvent(new Event('complete'));
  });
  await act(async () => {
    login.activeProfileId = 'second';
    login.dispatchEvent(new Event('token-profiles-change'));
  });
  expect(balance().textContent).toContain('—');

  await act(async () => newLookup.resolve(50));
  expect(balance().getAttribute('aria-label')).toBe('Anlas 50');
  await act(async () => oldLookup.resolve(9999));
  expect(balance().getAttribute('aria-label')).toBe('Anlas 50');
});

test('manual token replacement also clears a balance when the profile ID is unchanged', async () => {
  login.activeProfileId = undefined;
  await renderBar();
  const pending = deferred<number>();
  getRemainCredits.mockReturnValueOnce(pending.promise);

  await act(async () => {
    login.dispatchEvent(new Event('change'));
  });
  expect(balance().textContent).toContain('—');
  await act(async () => pending.resolve(42));
  expect(balance().getAttribute('aria-label')).toBe('Anlas 42');
});

test('renaming a saved profile does not start another account query', async () => {
  await renderBar();
  await act(async () => {
    login.dispatchEvent(new Event('token-profiles-change'));
  });

  expect(getRemainCredits).toHaveBeenCalledTimes(1);
  expect(getOpusUsageStatus).toHaveBeenCalledTimes(1);
});

test('completion events coalesce while a balance request is pending, then retain one follow-up refresh', async () => {
  const first = deferred<number>();
  const latest = deferred<number>();
  getRemainCredits
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(latest.promise);
  await renderBar();

  await act(async () => {
    tasks.dispatchEvent(new Event('complete'));
    images.dispatchEvent(new Event('encode-vibe'));
    tasks.dispatchEvent(new Event('complete'));
  });
  expect(getRemainCredits).toHaveBeenCalledTimes(1);

  await act(async () => first.resolve(1200));
  expect(getRemainCredits).toHaveBeenCalledTimes(2);
  await act(async () => latest.resolve(1100));
  expect(balance().getAttribute('aria-label')).toBe('Anlas 1,100');
  expect(getRemainCredits).toHaveBeenCalledTimes(2);
});

test('logout and unmount detach account updates without adding a server polling timer', async () => {
  jest.useFakeTimers();
  await renderBar();
  await act(async () => {
    jest.advanceTimersByTime(60 * 60 * 1000);
  });
  expect(getRemainCredits).toHaveBeenCalledTimes(1);

  await act(async () => {
    login.loggedIn = false;
    login.dispatchEvent(new Event('change'));
  });
  expect(container.querySelector('[aria-label^="Anlas "]')).toBeNull();
  expect(container.textContent).toContain('로그인');

  act(() => root.unmount());
  tasks.dispatchEvent(new Event('complete'));
  images.dispatchEvent(new Event('encode-vibe'));
  expect(getRemainCredits).toHaveBeenCalledTimes(1);
});

test('the desktop account region sits beside named native window controls and retains the full large balance', async () => {
  getRemainCredits.mockResolvedValue(1234567890123);
  await renderBar();

  const account = container.querySelector(
    '[role="group"][aria-label="계정 잔액 및 생성 할당량"]',
  );
  const controls = container.querySelector(
    '[role="group"][aria-label="창 제어"]',
  );
  expect(account).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(account?.nextElementSibling).toBe(controls);
  expect(balance().title).toContain('1,234,567,890,123');

  const minimize = controls?.querySelector<HTMLButtonElement>(
    'button[aria-label="최소화"]',
  );
  expect(minimize).not.toBeNull();
  await act(async () => minimize?.click());
  expect(invoke).toHaveBeenCalledWith('window-minimize');
  expect(controls?.querySelector('button[aria-label="최대화"]')).not.toBeNull();
  expect(controls?.querySelector('button[aria-label="닫기"]')).not.toBeNull();
});
