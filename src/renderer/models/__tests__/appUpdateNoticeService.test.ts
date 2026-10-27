/** A private fork must not recommend replacing itself with a public upstream release. */

const getVersion = jest.fn(async () => '5.5.2');

// Load the subject after its mock fixtures have been initialized.
const { AppUpdateNoticeService } = jest.requireActual<
  typeof import('../AppUpdateNoticeService')
>('../AppUpdateNoticeService');

const originalFetch = global.fetch;
const fetchRelease = jest.fn(async () => ({
  ok: true,
  json: async () => ({ tag_name: 'v999.0.0' }),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  global.fetch = fetchRelease as unknown as typeof fetch;
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  global.fetch = originalFetch;
});

test('a build without a native updater stays unverified without querying public upstream', async () => {
  const service = new AppUpdateNoticeService({ getVersion });
  await expect(service.checkForUpdate()).rejects.toThrow(
    '이 환경에서는 자동 업데이트를 사용할 수 없어요.',
  );
  expect(getVersion).toHaveBeenCalledTimes(1);
  expect(fetchRelease).not.toHaveBeenCalled();
  expect(service.checked).toBe(false);
  expect(service.outdated).toBe(false);
});

test('private update service has no recurring network polling or update event', async () => {
  const service = new AppUpdateNoticeService({ getVersion });
  const updated = jest.fn();
  service.addEventListener('updated', updated);
  void service.run();
  await jest.advanceTimersByTimeAsync(0);
  expect(fetchRelease).not.toHaveBeenCalled();
  expect(updated).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
