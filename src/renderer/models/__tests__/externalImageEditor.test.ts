import { openWatchedImage, releaseImageWatches } from '../externalImageEditor';

describe('external image editor subscriptions', () => {
  it('shares metadata initialization across repeat clicks and releases its single watch', async () => {
    const leases = new Map<string, Promise<void>>();
    let complete!: () => void;
    const backend = {
      watchImage: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      ),
      unwatchImage: jest.fn(async () => {}),
      openImageEditor: jest.fn(async () => {}),
    };
    const first = openWatchedImage(leases, 'scene/image.png', backend);
    const second = openWatchedImage(leases, 'scene/image.png', backend);
    expect(backend.watchImage).toHaveBeenCalledTimes(1);
    expect(backend.openImageEditor).not.toHaveBeenCalled();
    complete();
    await Promise.all([first, second]);
    await releaseImageWatches(leases, backend);
    expect(backend.unwatchImage).toHaveBeenCalledTimes(1);
    expect(leases.size).toBe(0);
  });

  it('releases a watch and skips opening the editor if the view unmounts during its metadata read', async () => {
    const leases = new Map<string, Promise<void>>();
    let complete!: () => void;
    const backend = {
      watchImage: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      ),
      unwatchImage: jest.fn(async () => {}),
      openImageEditor: jest.fn(async () => {}),
    };
    const editing = openWatchedImage(leases, 'scene/image.png', backend);
    const unmounting = releaseImageWatches(leases, backend);
    complete();
    await Promise.all([editing, unmounting]);
    expect(backend.openImageEditor).not.toHaveBeenCalled();
    expect(backend.unwatchImage).toHaveBeenCalledTimes(1);
    expect(leases.size).toBe(0);
  });
});
