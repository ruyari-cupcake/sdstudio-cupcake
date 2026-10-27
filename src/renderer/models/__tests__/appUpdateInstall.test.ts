import { installApplicationUpdate } from '../appUpdateInstall';
import { AppUpdateNoticeService } from '../AppUpdateNoticeService';

function fixture() {
  const service = new AppUpdateNoticeService({
    getVersion: async () => '6.1.0',
  });
  service.phase = 'ready';
  const steps: string[] = [];
  const dependencies = {
    assertIdle: jest.fn(() => {
      steps.push('idle');
    }),
    flush: jest.fn(async () => {
      steps.push('save');
    }),
    install: jest.fn(async () => {
      steps.push('install');
    }),
    cancel: jest.fn(async () => {
      steps.push('cancel');
    }),
    mobile: false,
  };
  return { service, dependencies, steps };
}

it('saves and rechecks work before asking the native installer to close', async () => {
  const { service, dependencies, steps } = fixture();
  await installApplicationUpdate(service, dependencies);
  expect(steps).toEqual(['idle', 'save', 'idle', 'install']);
  expect(service.phase).toBe('installing');
});

it('keeps the app open and restores interaction when saving fails', async () => {
  const { service, dependencies } = fixture();
  dependencies.flush.mockRejectedValueOnce(new Error('저장 실패'));
  await installApplicationUpdate(service, dependencies);
  expect(dependencies.install).not.toHaveBeenCalled();
  expect(dependencies.cancel).toHaveBeenCalledTimes(1);
  expect(service.phase).toBe('ready');
  expect(service.error).toBe('저장 실패');
});

it('rejects new work admitted while the save barrier was draining', async () => {
  const { service, dependencies } = fixture();
  dependencies.assertIdle.mockImplementationOnce(() => {});
  dependencies.assertIdle.mockImplementationOnce(() => {
    throw new Error('작업 중');
  });
  await installApplicationUpdate(service, dependencies);
  expect(dependencies.install).not.toHaveBeenCalled();
  expect(service.phase).toBe('ready');
  expect(service.error).toBe('작업 중');
});

it('coalesces same-tick install clicks while saving', async () => {
  const { service, dependencies } = fixture();
  let resolve!: () => void;
  dependencies.flush.mockReturnValueOnce(
    new Promise<void>((_resolve) => {
      resolve = _resolve;
    }),
  );
  const first = installApplicationUpdate(service, dependencies);
  const second = installApplicationUpdate(service, dependencies);
  resolve();
  await Promise.all([first, second]);
  expect(dependencies.flush).toHaveBeenCalledTimes(1);
  expect(dependencies.install).toHaveBeenCalledTimes(1);
});

it('lets Android return to the app while the OS owns installation confirmation', async () => {
  const { service, dependencies } = fixture();
  dependencies.mobile = true;
  await installApplicationUpdate(service, dependencies);
  expect(dependencies.install).toHaveBeenCalledTimes(1);
  expect(service.phase).toBe('ready');
  expect(service.notificationOpen).toBe(false);
});
