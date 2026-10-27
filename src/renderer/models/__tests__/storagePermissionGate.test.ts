import {
  deferred,
  flushMicrotasks,
} from '../testSupport/completionMethodHarness';

const storagePermissionStatus = jest.fn();
const addListener = jest.fn();
const reloadConfigIfFailed = jest.fn(async () => undefined);
const appState = { storagePermissionBlocked: false, bootStatusMessage: '' };

jest.mock('..', () => ({
  isMobile: true,
  backend: { reloadConfigIfFailed },
}));
jest.mock('../AppService', () => ({ appState }));
jest.mock('../../backends/zipService', () => ({
  __esModule: true,
  default: { storagePermissionStatus },
}));
jest.mock('@capacitor/app', () => ({ App: { addListener } }));

const { waitForStorageAccess } = jest.requireActual<
  typeof import('../storagePermissionGate')
>('../storagePermissionGate');

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  appState.storagePermissionBlocked = false;
  appState.bootStatusMessage = '';
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('permission acquisition releases a listener whose registration settles late', async () => {
  const registration = deferred<{ remove: () => Promise<void> }>();
  const remove = jest.fn(async () => undefined);
  addListener.mockReturnValue(registration.promise);
  storagePermissionStatus.mockResolvedValue({ required: true, granted: false });
  const waiting = waitForStorageAccess();
  await flushMicrotasks();
  expect(addListener).toHaveBeenCalledWith(
    'appStateChange',
    expect.any(Function),
  );
  expect(appState.storagePermissionBlocked).toBe(true);
  expect(reloadConfigIfFailed).not.toHaveBeenCalled();

  storagePermissionStatus.mockRejectedValueOnce(
    new Error('status temporarily unavailable'),
  );
  await jest.advanceTimersByTimeAsync(1000);
  expect(appState.storagePermissionBlocked).toBe(true);
  expect(reloadConfigIfFailed).not.toHaveBeenCalled();

  storagePermissionStatus.mockResolvedValue({ required: true, granted: true });
  await jest.advanceTimersByTimeAsync(1000);
  await waiting;
  expect(appState.storagePermissionBlocked).toBe(false);
  expect(reloadConfigIfFailed).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  expect(remove).not.toHaveBeenCalled();

  registration.resolve({ remove });
  await flushMicrotasks();
  expect(remove).toHaveBeenCalledTimes(1);
});

test('permission alone does not permit boot when the saved configuration is unreadable', async () => {
  const failure = new Error('saved config read failed');
  storagePermissionStatus.mockResolvedValue({ required: true, granted: true });
  reloadConfigIfFailed.mockRejectedValueOnce(failure);
  await expect(waitForStorageAccess()).rejects.toBe(failure);
  expect(reloadConfigIfFailed).toHaveBeenCalledTimes(1);
});
