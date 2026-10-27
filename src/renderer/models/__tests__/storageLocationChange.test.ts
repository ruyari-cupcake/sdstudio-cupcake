/** @jest-environment node */
import {
  changeStorageLocation,
  type StorageLocationChangeState,
} from '../storageLocationChange';
import {
  deferred,
  flushMicrotasks,
} from '../testSupport/completionMethodHarness';

function fixture() {
  const calls: string[] = [];
  let state: StorageLocationChangeState | null = null;
  let busy = false;
  const dependencies = {
    assertIdle: jest.fn(() => {
      if (busy) throw new Error('paid result pending');
    }),
    flush: jest.fn(async () => {
      calls.push('flush');
    }),
    commit: jest.fn(async (target: string) => {
      calls.push(`commit:${target}`);
    }),
    restart: jest.fn(async () => {
      calls.push('restart');
    }),
    setState: (value: StorageLocationChangeState | null) => {
      state = value;
    },
  };
  return {
    dependencies,
    calls,
    state: () => state,
    busy: () => {
      busy = true;
    },
  };
}
test('the data flush settles before commit or restart and the target stays pending until the new process', async () => {
  const f = fixture();
  const flush = deferred<void>();
  f.dependencies.flush.mockReturnValueOnce(flush.promise);
  const change = changeStorageLocation('D:/chosen', f.dependencies);
  expect(f.state()).toEqual({ path: 'D:/chosen', phase: 'saving' });
  await flushMicrotasks();
  expect(f.dependencies.commit).not.toHaveBeenCalled();
  expect(f.dependencies.restart).not.toHaveBeenCalled();
  flush.resolve();
  await change;
  expect(f.calls).toEqual(['commit:D:/chosen', 'restart']);
  expect(f.state()).toEqual({ path: 'D:/chosen', phase: 'restarting' });
});
test('failed old-root save leaves the configured location untouched and permits retry', async () => {
  const f = fixture();
  f.dependencies.flush.mockRejectedValueOnce(new Error('save denied'));
  await expect(
    changeStorageLocation('D:/chosen', f.dependencies),
  ).rejects.toThrow('save denied');
  expect(f.dependencies.commit).not.toHaveBeenCalled();
  expect(f.dependencies.restart).not.toHaveBeenCalled();
  expect(f.state()).toBeNull();
});
test('an operation that starts while the flush was waiting blocks the root commit', async () => {
  const f = fixture();
  const flush = deferred<void>();
  f.dependencies.flush.mockReturnValueOnce(flush.promise);
  const change = changeStorageLocation('D:/chosen', f.dependencies);
  f.busy();
  flush.resolve();
  await expect(change).rejects.toThrow('paid result pending');
  expect(f.dependencies.commit).not.toHaveBeenCalled();
  expect(f.dependencies.restart).not.toHaveBeenCalled();
  expect(f.state()).toBeNull();
});
test('failed restart after commit remains gated and never runs a second commit', async () => {
  const f = fixture();
  f.dependencies.restart.mockRejectedValueOnce(new Error('restart rejected'));
  await expect(
    changeStorageLocation('D:/chosen', f.dependencies),
  ).rejects.toThrow('restart rejected');
  expect(f.dependencies.commit).toHaveBeenCalledTimes(1);
  expect(f.state()).toEqual({
    path: 'D:/chosen',
    phase: 'restarting',
    error: 'restart rejected',
  });
});
test('a rejected configuration replacement releases the transition without claiming the path applied', async () => {
  const f = fixture();
  f.dependencies.commit.mockRejectedValueOnce(new Error('config disk full'));
  await expect(
    changeStorageLocation('D:/chosen', f.dependencies),
  ).rejects.toThrow('config disk full');
  expect(f.dependencies.restart).not.toHaveBeenCalled();
  expect(f.state()).toBeNull();
});
