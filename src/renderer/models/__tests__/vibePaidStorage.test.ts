import { ImageService } from '../ImageService';
import { backend } from '../index';
import { ModelVersion } from '../../backends/imageGen';
import { createNaiApiError } from '../../backends/genVendors/naiErrors';

jest.mock('../index', () => ({
  backend: { encodeVibeImage: jest.fn(async () => 'PAID-ENCODING') },
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
  jest
    .spyOn(service, 'fetchVibeImage')
    .mockResolvedValue('data:image/png;base64,IMAGE');
  const store = jest
    .spyOn(service, 'storeEncodedVibeImage')
    .mockResolvedValue('image.png&info=1');
  return { service, store };
}
beforeEach(() => {
  jest.clearAllMocks();
  (backend.encodeVibeImage as jest.Mock).mockResolvedValue('PAID-ENCODING');
});
afterEach(() => jest.restoreAllMocks());

test('a failed paid-encoding save pauses the task instead of allowing another paid encoder request', async () => {
  const { service, store } = fixture();
  const writeError = new Error('disk full');
  store.mockRejectedValueOnce(writeError);
  const error = await service
    .encodeVibeImage(
      { name: 'project' } as any,
      'image.png',
      1,
      undefined,
      ModelVersion.V4_5,
    )
    .then(
      () => undefined,
      (failure: unknown) => failure,
    );
  expect(error).toMatchObject({
    retryable: false,
    outcomeUnknown: true,
    cause: { cause: writeError },
  });
  expect((error as Error).message).toContain('저장');
  expect((error as Error).message).toContain('청구');
  expect(backend.encodeVibeImage).toHaveBeenCalledTimes(1);
  expect(store).toHaveBeenCalledWith(
    { name: 'project' },
    'image.png',
    'PAID-ENCODING',
    1,
  );
  expect(
    service.encodedVibeExistsCache.get(
      'vibes/project/encoded/image.png&info=1',
    ),
  ).toBeNull();
});

test('a known provider rejection retains its existing decision and never enters the storage boundary', async () => {
  const { service, store } = fixture();
  const rejection = createNaiApiError(429, 'rate limited');
  (backend.encodeVibeImage as jest.Mock).mockRejectedValueOnce(rejection);
  await expect(
    service.encodeVibeImage(
      { name: 'project' } as any,
      'image.png',
      1,
      undefined,
      ModelVersion.V4_5,
    ),
  ).rejects.toBe(rejection);
  expect(store).not.toHaveBeenCalled();
});
