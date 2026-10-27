const addListener = jest.fn();
const minimizeApp = jest.fn();

jest.mock('@capacitor/app', () => ({
  App: { addListener, minimizeApp },
}));
jest.mock('..', () => ({ isMobile: true }));
jest.mock('../platform', () => {
  const actual = jest.requireActual('../platform');
  return { ...actual, platform: { ...actual.platform, isMobile: true } };
});

const { backStackService } = jest.requireActual<
  typeof import('../BackStackService')
>('../BackStackService');

afterEach(() => {
  jest.restoreAllMocks();
});

it('reports failed registration and retries on the next explicit initialization without duplicates', async () => {
  const error = new Error('listener registration failed');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  addListener.mockRejectedValueOnce(error);
  addListener.mockResolvedValueOnce({ remove: jest.fn() });

  backStackService.init();
  await Promise.resolve();
  await Promise.resolve();

  expect(warn).toHaveBeenCalledWith(
    'Unable to register Android back-button listener',
    error,
  );
  backStackService.init();
  await Promise.resolve();
  backStackService.init();
  expect(addListener).toHaveBeenCalledTimes(2);
  expect(addListener).toHaveBeenLastCalledWith(
    'backButton',
    backStackService.handleBack,
  );
});

it('observes a failed minimize request when the back stack is empty', async () => {
  const error = new Error('minimize failed');
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  minimizeApp.mockRejectedValueOnce(error);

  backStackService.handleBack();
  await Promise.resolve();
  await Promise.resolve();

  expect(minimizeApp).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    'Unable to minimize the Android app',
    error,
  );
});
