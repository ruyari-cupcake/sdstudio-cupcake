import { BrowserNovelAiFetcher, NativeNovelAiFetcher } from '../naiTransport';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}

describe('NAI paid transport lifecycle', () => {
  afterEach(() => jest.useRealTimers());

  test('browser request waits beyond the removed deadline and delivers its late body', async () => {
    jest.useFakeTimers();
    const pending = deferred<Response>();
    const request = jest.fn().mockReturnValue(pending.promise);
    const controller = new AbortController();
    const result = new BrowserNovelAiFetcher(request).fetchArrayBuffer(
      'https://fixture.invalid',
      {},
      {},
      { signal: controller.signal },
    );
    await Promise.resolve(); // request encoding settles before dispatch
    jest.advanceTimersByTime(3_600_000);
    expect(controller.signal.aborted).toBe(false);
    expect(request.mock.calls[0][1].signal).toBe(controller.signal);
    const bytes = new Uint8Array([9, 7, 5]).buffer;
    pending.resolve({ ok: true, arrayBuffer: async () => bytes } as Response);
    expect(await result).toEqual(bytes);
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('native transport cancels only on Stop and awaits native settlement', async () => {
    jest.useFakeTimers();
    const pending = deferred<{ data: string; status: number }>();
    const bridge = {
      fetchData: jest.fn().mockReturnValue(pending.promise),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new AbortController();
    let settled = false;
    const result = new NativeNovelAiFetcher(bridge, () => 'owned-request')
      .fetchArrayBuffer(
        'https://fixture.invalid',
        { model: 'fixture' },
        {},
        { signal: controller.signal },
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve(); // request encoding settles before dispatch
    jest.advanceTimersByTime(3_600_000);
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(bridge.fetchData.mock.calls[0][0]).not.toHaveProperty('timeoutMs');
    controller.abort();
    expect(bridge.cancel).toHaveBeenCalledWith({ requestId: 'owned-request' });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve({ status: 200, data: 'CQcF' });
    expect(new Uint8Array(await result)).toEqual(new Uint8Array([9, 7, 5]));
    controller.abort();
    expect(bridge.cancel).toHaveBeenCalledTimes(1);
  });

  test('pre-canceled native request never reaches the bridge', async () => {
    const bridge = { fetchData: jest.fn(), cancel: jest.fn() };
    const controller = new AbortController();
    controller.abort();
    await expect(
      new NativeNovelAiFetcher(bridge, () => 'never').fetchArrayBuffer(
        'https://fixture.invalid',
        {},
        {},
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(bridge.fetchData).not.toHaveBeenCalled();
  });
});
