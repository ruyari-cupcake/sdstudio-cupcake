import { PersistenceService } from '../PersistenceService';
import { deferred } from '../testSupport/completionMethodHarness';

test('atomic replacement separates coalesced snapshots and remains owned by both drain methods until rename', async () => {
  const service = new PersistenceService();
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  const renameEntered = deferred<void>();
  const releaseRename = deferred<void>();
  const files = new Map<string, string>();
  const committed: string[] = [];
  const storage = {
    writeFile: jest.fn(async (filePath: string, data: string) => {
      files.set(filePath, data);
      if (filePath === 'state.json') committed.push(data);
      if (data === 'initial') {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
    }),
    renameFile: jest.fn(async (source: string, destination: string) => {
      renameEntered.resolve();
      await releaseRename.promise;
      const data = files.get(source)!;
      files.set(destination, data);
      files.delete(source);
      committed.push(data);
    }),
  };

  const first = service.write(storage, 'state.json', 'initial');
  await firstEntered.promise;
  const writes = [
    first,
    service.write(storage, 'state.json', 'before-old'),
    service.write(storage, 'state.json', 'before-latest'),
    service.writeAtomic(storage, 'state.json', 'candidate'),
    service.write(storage, 'state.json', 'after-old'),
    service.write(storage, 'state.json', 'after-latest'),
  ];
  let pathDrained = false;
  let allDrained = false;
  const pathDrain = service.flushPath('state.json').then(() => {
    pathDrained = true;
    return undefined;
  });
  const allDrain = service.flushAll().then(() => {
    allDrained = true;
    return undefined;
  });
  releaseFirst.resolve();
  await renameEntered.promise;
  const pendingState = {
    value: files.get('state.json'),
    pathDrained,
    allDrained,
  };
  releaseRename.resolve();
  await Promise.all([...writes, pathDrain, allDrain]);

  expect(pendingState).toEqual({
    value: 'before-latest',
    pathDrained: false,
    allDrained: false,
  });
  expect(committed).toEqual([
    'initial',
    'before-latest',
    'candidate',
    'after-latest',
  ]);
  expect(files.get('state.json')).toBe('after-latest');
  expect(files.has('state.json.tmp')).toBe(false);
  expect(pathDrained && allDrained).toBe(true);
});

test('a failed replacement preserves the committed file and does not poison its later retry', async () => {
  const service = new PersistenceService();
  const files = new Map([['state.json', 'previous']]);
  const storage = {
    writeFile: jest.fn(async (filePath: string, data: string) => {
      files.set(filePath, data);
    }),
    renameFile: jest
      .fn(async (source: string, destination: string) => {
        files.set(destination, files.get(source)!);
        files.delete(source);
      })
      .mockRejectedValueOnce(new Error('rename denied')),
  };

  await expect(
    service.writeAtomic(storage, 'state.json', 'failed-candidate'),
  ).rejects.toThrow('rename denied');
  expect(files.get('state.json')).toBe('previous');

  await expect(
    service.writeAtomic(storage, 'state.json', 'retry-candidate'),
  ).resolves.toBeUndefined();
  expect(files.get('state.json')).toBe('retry-candidate');
  expect(files.has('state.json.tmp')).toBe(false);
  expect(storage.writeFile).toHaveBeenCalledTimes(2);
  expect(storage.renameFile).toHaveBeenCalledTimes(2);
});
