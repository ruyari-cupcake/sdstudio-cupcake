import { ImageService } from '../ImageService';
import { backend } from '../index';
import { platform } from '../platform';

jest.mock('../index', () => ({
  backend: {
    existFile: jest.fn(async () => true),
    readDataFile: jest.fn(async () => 'data:image/png;base64,aGVsbG8='),
    resizeImage: jest.fn(async () => {}),
    renameFile: jest.fn(async () => {}),
  },
  isMobile: false,
  gameService: {},
  imageService: {},
  taskQueueService: {},
  trashService: {},
}));

const flush = async () => {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
};

describe('image resource ownership under a burst', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (backend.readDataFile as jest.Mock).mockResolvedValue(
      'data:image/png;base64,aGVsbG8=',
    );
    (backend.existFile as jest.Mock).mockResolvedValue(true);
  });

  it('invalidates an overwritten destination when the renamed source was not cached', async () => {
    const service = new ImageService();
    service.cache.set('outs/a/new.png', 'old destination');
    await service.onRenameFile('outs/a/uncached.png', 'outs/a/new.png');
    expect(service.cache.get('outs/a/new.png')).toBeNull();
    expect(service.cache.totalBytes).toBe(0);
  });

  it('shares one oversized read among concurrent callers without retaining its result', async () => {
    const service = new ImageService();
    service.cache.byteLimit = 16;
    const source = 'x'.repeat(128);
    let complete!: () => void;
    (backend.readDataFile as jest.Mock).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          complete = () => resolve(source);
        }),
    );
    const work = Promise.all(
      Array.from({ length: 64 }, () => service.fetchImage('large.png')),
    );
    await flush();
    expect(backend.readDataFile).toHaveBeenCalledTimes(1);
    complete();
    expect(await work).toEqual(Array(64).fill(source));
    expect(service.cache.totalBytes).toBe(0);
  });

  it('releases a failed read slot and permits a later retry without poisoning the image mutex', async () => {
    const service = new ImageService();
    (backend.readDataFile as jest.Mock).mockImplementation(
      async (path: string) => {
        if (path === 'failed.png') throw new Error('read failed');
        return path;
      },
    );
    const paths = [
      'failed.png',
      ...Array.from(
        { length: platform.exportConcurrency + 4 },
        (_, i) => `valid-${i}.png`,
      ),
    ];
    const result = await Promise.allSettled(
      paths.map((path) => service.fetchImage(path)),
    );
    expect(result[0].status).toBe('rejected');
    expect(result.slice(1)).toEqual(
      paths.slice(1).map((path) => ({ status: 'fulfilled', value: path })),
    );
    expect(Object.keys(service.mutexes)).toEqual([]);
    (backend.readDataFile as jest.Mock).mockResolvedValue('recovered');
    expect(await service.fetchImage('failed.png')).toBe('recovered');
  });

  it('manual cache reset releases values and resets byte accounting before reuse', () => {
    const service = new ImageService();
    service.cache.set('old.png', 'old retained value');
    service.cache.clear();
    expect(service.cache.cache.size).toBe(0);
    expect(service.cache.totalBytes).toBe(0);
    service.cache.set('new.png', 'new');
    expect(service.cache.totalBytes).toBe(3);
  });

  it('serves an oversized source without retaining it or evicting useful thumbnails', async () => {
    const service = new ImageService();
    service.cache.byteLimit = 16;
    service.cache.set('thumbnail', 'small');
    const source = 'x'.repeat(128);
    (backend.readDataFile as jest.Mock).mockResolvedValue(source);
    expect(await service.fetchImage('original.png')).toBe(source);
    expect(service.cache.totalBytes).toBeLessThanOrEqual(16);
    expect(service.cache.get('original.png')).toBeNull();
    expect(service.cache.get('thumbnail')).toBe('small');
  });

  it('keeps accounting correct when a renamed image replaces an existing cache key', async () => {
    const service = new ImageService();
    service.cache.set('outs/a/old.png', '123');
    service.cache.set('outs/a/new.png', '1234567');
    await service.onRenameFile('outs/a/old.png', 'outs/a/new.png');
    expect(service.cache.get('outs/a/old.png')).toBeNull();
    expect(service.cache.get('outs/a/new.png')).toBe('123');
    expect(service.cache.totalBytes).toBe(3);
  });

  it('limits simultaneous decoded-image work while completing every queued read', async () => {
    const service = new ImageService();
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    (backend.readDataFile as jest.Mock).mockImplementation((path: string) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise<string>((resolve) => {
        release.push(() => {
          active -= 1;
          resolve(path);
        });
      });
    });
    const paths = Array.from(
      { length: 64 },
      (_, index) => `image-${index}.png`,
    );
    const work = Promise.all(paths.map((path) => service.fetchImage(path)));
    await flush();
    const observedPeak = peak;
    // Drain by completion events rather than elapsed time; no caller is dropped.
    for (let wave = 0; wave < paths.length; wave += 1) {
      release.splice(0).forEach((done) => done());
      await flush();
    }
    expect(await work).toEqual(paths);
    expect(peak).toBeLessThanOrEqual(platform.exportConcurrency);
    expect(observedPeak).toBeGreaterThan(0);
    // eslint-disable-next-line no-console -- Record the observed concurrency budget alongside its assertions.
    console.info(
      '[image-resources]',
      JSON.stringify({ requests: paths.length, peak, active }),
    );
  });
});
