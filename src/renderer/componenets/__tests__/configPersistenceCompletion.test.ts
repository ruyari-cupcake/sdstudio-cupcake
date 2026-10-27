import path from 'path';
import loadFunctionFixture from '../testSupport/functionFixture';

const source = path.resolve(__dirname, '../ConfigScreen.tsx');
function migrationFixture() {
  const order: string[] = [];
  const pushMessage = jest.fn();
  const sessionService = {
    flushOnClose: jest.fn(async () => {
      order.push('session');
    }),
  };
  const persistService = {
    flushAll: jest.fn(async () => {
      order.push('persist');
    }),
  };
  const migrationService = {
    clearOptOut: jest.fn(async () => {
      order.push('migration');
    }),
  };
  const backend = {
    restartApp: jest.fn(async () => {
      order.push('restart');
    }),
  };
  const callback = loadFunctionFixture(
    source,
    { property: 'callback', contains: 'await migrationService.clearOptOut()' },
    {
      sessionService,
      persistService,
      migrationService,
      backend,
      appState: { pushMessage },
    },
  );
  return {
    order,
    pushMessage,
    sessionService,
    persistService,
    migrationService,
    backend,
    callback,
  };
}

test.each(['session', 'persist'])(
  'migration cannot restart after a failed %s flush',
  async (failure) => {
    const f = migrationFixture();
    if (failure === 'session')
      f.sessionService.flushOnClose.mockRejectedValue(
        new Error('session write failed'),
      );
    else
      f.persistService.flushAll.mockRejectedValue(
        new Error('settings write failed'),
      );
    await f.callback();
    expect(f.backend.restartApp).not.toHaveBeenCalled();
    expect(f.migrationService.clearOptOut).not.toHaveBeenCalled();
    expect(f.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('실패'),
      'error',
    );
  },
);

test('migration is enabled only after current data has been persisted', async () => {
  const f = migrationFixture();
  await f.callback();
  expect(f.order).toEqual(['session', 'persist', 'migration', 'restart']);
});

function cacheFixture() {
  const curSession = {
    name: 'session',
    scenes: new Map([['normal', { name: 'normal', type: 'scene' }]]),
    inpaints: new Map([['variant', { name: 'variant', type: 'inpaint' }]]),
  };
  const pushMessage = jest.fn();
  const pushDialog = jest.fn();
  const backend = {
    existFile: jest.fn(async () => true),
    deleteDir: jest.fn(async (_cachePath: string) => {}),
  };
  const imageService = {
    cache: { clear: jest.fn() },
    refreshBatch: jest.fn(async () => {}),
    getImageDir: (_session: unknown, scene: { name: string }) =>
      `images/${scene.name}`,
    getOutputDir: (_session: unknown, scene: { name: string; type: string }) =>
      `${scene.type === 'inpaint' ? 'inpaints' : 'images'}/${scene.name}`,
  };
  const clear = loadFunctionFixture(
    source,
    { name: 'clearImageCache' },
    {
      curSession,
      backend,
      imageService,
      appState: { pushMessage, pushDialog },
    },
  );
  return { clear, backend, imageService, pushMessage, pushDialog };
}

test('cache clearing iterates both scene maps and their actual cache directories', async () => {
  const f = cacheFixture();
  await f.clear();
  expect(f.backend.deleteDir.mock.calls).toEqual([
    ['images/normal/fastcache'],
    ['inpaints/variant/fastcache'],
  ]);
  expect(f.imageService.refreshBatch).toHaveBeenCalledTimes(1);
});

test('a cache deletion error cannot be reported as complete', async () => {
  const f = cacheFixture();
  f.backend.deleteDir.mockRejectedValue(new Error('permission denied'));
  await f.clear();
  expect(f.pushDialog).not.toHaveBeenCalledWith(
    expect.objectContaining({ text: '이미지 캐시 초기화 완료' }),
  );
  expect(f.pushMessage).toHaveBeenCalledWith(
    expect.stringContaining('실패'),
    'error',
  );
});

test('cache refresh failure is handled with a visible terminal error', async () => {
  const f = cacheFixture();
  f.imageService.refreshBatch.mockRejectedValue(new Error('refresh failed'));
  await expect(f.clear()).resolves.toBeUndefined();
  expect(f.pushDialog).not.toHaveBeenCalled();
  expect(f.pushMessage).toHaveBeenCalledWith(
    expect.stringContaining('실패'),
    'error',
  );
});
