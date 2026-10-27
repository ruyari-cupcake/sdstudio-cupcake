/** @jest-environment node */
import path from 'path';
import { setImmediate as nextTurn } from 'timers/promises';
import {
  ImageWatchService,
  type ImageDirectoryWatcher,
} from '../imageWatchService';

function fixture() {
  const listeners = new Map<string, (file: string) => void>();
  const closers: jest.Mock[] = [];
  const changed = jest.fn();
  const versions = new Map<string, string>();
  let serial = 0;
  const writeTags = jest.fn(async (file: string) => {
    serial += 1;
    versions.set(file, `written-${serial}`);
  });
  const readTags = jest.fn(async () => ({ Comment: 'retained prompt' }));
  const report = jest.fn();
  const service = new ImageWatchService({
    root: () => path.resolve('/test-images'),
    readTags,
    writeTags,
    fingerprint: async (file) => versions.get(file) ?? 'initial',
    changed,
    report,
    watchDirectory: (directory) => {
      const close = jest.fn(async () => {});
      closers.push(close);
      const handle: ImageDirectoryWatcher = {
        on: (event, listener) => {
          if (event === 'change') listeners.set(directory, listener);
          return handle;
        },
        close,
      };
      return handle;
    },
  });
  return {
    service,
    closers,
    listeners,
    changed,
    writeTags,
    readTags,
    report,
    versions,
  };
}

describe('external editor image watch ownership', () => {
  it.each([false, true])(
    'settles owned initialization after close fails, preserving a replacement owner (sync=%s)',
    async (synchronously) => {
      const f = fixture();
      let resolveTags!: (tags: { Comment: string }) => void;
      f.readTags.mockImplementationOnce(
        () =>
          new Promise<{ Comment: string }>((resolve) => {
            resolveTags = resolve;
          }),
      );
      const originalWatch = f.service.watch(1, 'scene/image.png');
      await Promise.resolve();
      const closeFailure = new Error('native close failed');
      f.closers[0].mockImplementationOnce(() => {
        if (synchronously) throw closeFailure;
        return Promise.reject(closeFailure);
      });
      let settled = false;
      const closing = f.service.unwatch(1, 'scene/image.png').then(
        () => {
          settled = true;
          throw new Error('Expected the native close failure');
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await f.service.watch(2, 'scene/image.png');
      await nextTurn();
      expect(settled).toBe(false);
      expect(f.service.files.size).toBe(1);
      expect(f.service.directories.size).toBe(1);
      resolveTags({ Comment: 'old owner completed after replacement' });
      await originalWatch;
      await expect(closing).resolves.toBe(closeFailure);
      expect(f.service.files.size).toBe(1);
      expect(f.service.directories.size).toBe(1);
      expect(f.closers[1]).not.toHaveBeenCalled();
      await f.service.unwatch(2, 'scene/image.png');
      expect(f.service.files.size).toBe(0);
      expect(f.service.directories.size).toBe(0);
      expect(f.closers[1]).toHaveBeenCalledTimes(1);
    },
  );
  it('normalizes absolute and relative subscriptions to one key', async () => {
    const f = fixture();
    await f.service.watch(1, 'project/scene/./image.png');
    await f.service.unwatch(
      1,
      path.resolve('/test-images/project/scene/image.png'),
    );
    expect(f.service.files.size).toBe(0);
    expect(f.closers[0]).toHaveBeenCalledTimes(1);
  });

  it('releases a destroyed owner during metadata initialization without resurrecting its watcher', async () => {
    const f = fixture();
    let resolveTags!: (tags: { Comment: string }) => void;
    f.readTags.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTags = resolve;
        }),
    );
    const watching = f.service.watch(1, 'scene/image.png');
    await Promise.resolve();
    const closing = f.service.releaseOwner(1);
    expect(f.service.files.size).toBe(0);
    expect(f.closers[0]).toHaveBeenCalledTimes(1);
    resolveTags({ Comment: 'metadata returned after close' });
    await Promise.all([watching, closing]);
    expect(f.service.files.size).toBe(0);
    expect(f.service.directories.size).toBe(0);
  });

  it('counts multiple views in one window and releases all remaining views on window close', async () => {
    const f = fixture();
    await f.service.watch(1, 'scene/image.png');
    await f.service.watch(1, 'scene/image.png');
    await f.service.watch(2, 'scene/other.png');
    await f.service.unwatch(1, 'scene/image.png');
    expect(f.service.files.size).toBe(2);
    await f.service.releaseOwner(1);
    expect(f.service.files.size).toBe(1);
    expect(f.closers[0]).not.toHaveBeenCalled();
    await f.service.releaseOwner(2);
    expect(f.closers[0]).toHaveBeenCalledTimes(1);
  });

  it('coalesces a save event burst and suppresses its own completed metadata write', async () => {
    const f = fixture();
    const file = path.resolve('/test-images/scene/image.png');
    const directory = path.dirname(file);
    await f.service.watch(1, file);
    f.versions.set(file, 'editor-save-1');
    for (let i = 0; i < 64; i += 1) f.listeners.get(directory)!(file);
    await f.service.idle();
    expect(f.writeTags).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(1);
    f.listeners.get(directory)!(file);
    await f.service.idle();
    expect(f.writeTags).toHaveBeenCalledTimes(1);
    f.versions.set(file, 'editor-save-2');
    f.listeners.get(directory)!(file);
    await f.service.idle();
    expect(f.writeTags).toHaveBeenCalledTimes(2);
    await f.service.dispose();
  });

  it('does not discard another image save while a metadata write is active', async () => {
    const f = fixture();
    let finishFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    f.writeTags.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
          firstStarted();
        }),
    );
    const first = path.resolve('/test-images/scene/first.png');
    const second = path.resolve('/test-images/scene/second.png');
    await f.service.watch(1, first);
    await f.service.watch(1, second);
    const emit = f.listeners.get(path.dirname(first))!;
    emit(first);
    await started;
    emit(second);
    finishFirst();
    await f.service.idle();
    expect(f.writeTags.mock.calls.map(([file]) => file)).toEqual([
      first,
      second,
    ]);
    expect(f.changed).toHaveBeenCalledTimes(2);
    await f.service.dispose();
  });

  it('uses one normalized key and closes the last directory watcher', async () => {
    const f = fixture();
    await f.service.watch(1, 'project/scene/image.png');
    expect(f.service.files.size).toBe(1);
    await f.service.unwatch(1, 'project/scene/image.png');
    expect(f.service.files.size).toBe(0);
    expect(f.service.directories.size).toBe(0);
    expect(f.closers[0]).toHaveBeenCalledTimes(1);
  });

  it('retains a shared watch until its final caller releases it', async () => {
    const f = fixture();
    await f.service.watch(1, 'project/scene/image.png');
    await f.service.watch(2, 'project/scene/image.png');
    await f.service.unwatch(1, 'project/scene/image.png');
    expect(f.service.files.size).toBe(1);
    expect(f.closers[0]).not.toHaveBeenCalled();
    await f.service.unwatch(2, 'project/scene/image.png');
    expect(f.service.files.size).toBe(0);
    expect(f.closers[0]).toHaveBeenCalledTimes(1);
  });

  it('returns resources to baseline after repeated editor sessions', async () => {
    const f = fixture();
    for (let index = 0; index < 64; index += 1) {
      const image = `scene-${index}/image.png`;
      await f.service.watch(1, image);
      await f.service.unwatch(1, image);
    }
    expect(f.service.files.size).toBe(0);
    expect(f.service.directories.size).toBe(0);
    expect(f.closers.every((close) => close.mock.calls.length === 1)).toBe(
      true,
    );
  });
});
