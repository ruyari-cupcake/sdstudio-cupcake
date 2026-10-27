/** @jest-environment node */
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { createDataStorageHandler } from '../dataStorageGate';

test('boot/restart failures block data reads and writes at the native boundary', async () => {
  const callbacks = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const register: IpcMain['handle'] = (channel, callback) => {
    callbacks.set(channel, callback);
  };
  let failure: string | undefined;
  const handle = createDataStorageHandler(register, () => failure);
  const read = jest.fn(async () => ['preserved.json']);
  const write = jest.fn(
    async (_event: IpcMainInvokeEvent, content: string) => content,
  );
  handle('list-files', read);
  handle('write-file', write);
  const event = {} as IpcMainInvokeEvent;
  await expect(callbacks.get('list-files')!(event)).resolves.toEqual([
    'preserved.json',
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  for (const message of ['selected drive unavailable', 'restart pending']) {
    failure = message;
    expect(() => callbacks.get('list-files')!(event)).toThrow(message);
    expect(() => callbacks.get('write-file')!(event, 'must not write')).toThrow(
      message,
    );
  }
  expect(read).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
  failure = undefined;
  await expect(
    callbacks.get('write-file')!(event, 'selected-root-content'),
  ).resolves.toBe('selected-root-content');
});
