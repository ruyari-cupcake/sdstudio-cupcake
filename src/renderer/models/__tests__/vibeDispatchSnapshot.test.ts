import { ImageService } from '../ImageService';
import { backend } from '../index';
import { ModelVersion } from '../../backends/imageGen';
import { StaleAttemptError } from '../requestTiming';

jest.mock('../index', () => ({
  backend: { encodeVibeImage: jest.fn(async () => 'ENCODED') },
  isMobile: false,
  gameService: {},
  imageService: {},
  taskQueueService: {},
  trashService: {},
}));

function fixture() {
  const service = new ImageService();
  jest
    .spyOn(service, 'getVibeImagePath')
    .mockReturnValue('vibes/project/image.png');
  jest
    .spyOn(service, 'getEncodedVibeImagePath')
    .mockReturnValue('vibes/project/encoded/image.png&info=1');
  const read = jest
    .spyOn(service, 'fetchVibeImage')
    .mockResolvedValue('data:image/png;base64,IMAGE');
  const store = jest
    .spyOn(service, 'storeEncodedVibeImage')
    .mockResolvedValue('image.png&info=1');
  return { service, read, store };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
beforeEach(() => {
  jest.clearAllMocks();
  (backend.encodeVibeImage as jest.Mock).mockResolvedValue('ENCODED');
});
afterEach(() => jest.restoreAllMocks());

test('ImageService forwards the queued model to paid vibe encoding and preserves the existing disk cache identity', async () => {
  const f = fixture();
  await (f.service.encodeVibeImage as any)(
    { name: 'project' },
    'image.png',
    1,
    undefined,
    ModelVersion.V4_5,
  );
  expect(backend.encodeVibeImage).toHaveBeenCalledWith(
    expect.objectContaining({
      image: 'IMAGE',
      info: 1,
      modelVersion: ModelVersion.V4_5,
    }),
  );
  expect(f.store).toHaveBeenCalledWith(
    { name: 'project' },
    'image.png',
    'ENCODED',
    1,
  );
});

test('Stop during the source image read prevents the not-yet-dispatched paid encoder', async () => {
  const f = fixture();
  const read = deferred<string>();
  f.read.mockReturnValueOnce(read.promise);
  let stopped = false;
  const work = (f.service.encodeVibeImage as any)(
    { name: 'project' },
    'image.png',
    1,
    undefined,
    ModelVersion.V4_5,
    () => {
      if (stopped) throw new StaleAttemptError();
    },
  );
  const outcome = work.then(
    () => 'encoded',
    (error: unknown) => error,
  );
  await flush();
  stopped = true;
  read.resolve('data:image/png;base64,IMAGE');
  expect(await outcome).toBeInstanceOf(StaleAttemptError);
  expect(backend.encodeVibeImage).not.toHaveBeenCalled();
  expect(f.store).not.toHaveBeenCalled();
});

test('an encoder already in flight saves and records its paid encoding after Stop', async () => {
  const f = fixture();
  const encoded = deferred<string>();
  (backend.encodeVibeImage as jest.Mock).mockReturnValueOnce(encoded.promise);
  let stopped = false;
  const work = (f.service.encodeVibeImage as any)(
    { name: 'project' },
    'image.png',
    1,
    undefined,
    ModelVersion.V4_5,
    () => {
      if (stopped) throw new StaleAttemptError();
    },
  );
  await flush();
  expect(backend.encodeVibeImage).toHaveBeenCalledTimes(1);
  stopped = true;
  encoded.resolve('PAID-ENCODING');
  await expect(work).resolves.toBe('PAID-ENCODING');
  expect(f.store).toHaveBeenCalledWith(
    { name: 'project' },
    'image.png',
    'PAID-ENCODING',
    1,
  );
  expect(
    f.service.encodedVibeExistsCache.get(
      'vibes/project/encoded/image.png&info=1',
    ),
  ).toBe(true);
});
