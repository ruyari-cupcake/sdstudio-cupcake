import type { IpcMain } from 'electron';

/** Keep data-root failure/restart state at the native IO boundary, including reads
 * that otherwise convert ENOENT/ENOTDIR to an apparently empty project store. */
export function createDataStorageHandler(
  register: IpcMain['handle'],
  failure: () => string | undefined,
): IpcMain['handle'] {
  return (channel, listener) => {
    register(channel, (event, ...args) => {
      const message = failure();
      if (message)
        throw Object.assign(new Error(message), { code: 'STORAGE_NOT_READY' });
      return listener(event, ...args);
    });
  };
}
