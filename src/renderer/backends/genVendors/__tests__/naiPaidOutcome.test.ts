import { NovelAiImageGenService } from '../nai';
import { createNaiApiError } from '../naiErrors';
import {
  Model,
  ModelVersion,
  NoiseSchedule,
  Sampling,
  type ImageGenInput,
} from '../../imageGen';

jest.mock('../../imageDimensions', () => ({
  __esModule: true,
  default: jest.fn(async () => ({ width: 1024, height: 1024 })),
}));
jest.mock('libsodium-wrappers-sumo', () => ({ ready: Promise.resolve() }));

const getConfig = jest.fn(async () => {
  throw new Error('This fixture must not read live generation config');
});

const input = (): ImageGenInput => ({
  model: Model.Anime,
  prompt: 'night sky',
  uc: '',
  resolution: { width: 1024, height: 1024 },
  sampling: Sampling.KEulerAncestral,
  outputFilePath: 'fixture.png',
  steps: 23,
  promptGuidance: 5,
  cfgRescale: 0,
  noiseSchedule: NoiseSchedule.Karras,
  vibes: [],
  generationSettings: {
    schemaVersion: 1,
    modelVersion: ModelVersion.V5,
    furryMode: false,
    disableQuality: true,
    qualityPreset: 'none',
    ucPreset: 'none',
    autoConvertWebp: false,
    autoConvertWebpQuality: 80,
  },
});

describe('paid NAI request outcome ownership', () => {
  test('a connection loss after dispatch cannot be automatically paid for again', async () => {
    const fetcher = {
      fetchArrayBuffer: jest
        .fn()
        .mockRejectedValue(new TypeError('connection lost')),
    };
    const service = new NovelAiImageGenService(fetcher, getConfig);
    await expect(
      service.generateImage('fixture-token', input()),
    ).rejects.toMatchObject({
      retryable: false,
      outcomeUnknown: true,
    });
    expect(fetcher.fetchArrayBuffer).toHaveBeenCalledTimes(1);
  });

  test('an undecodable paid response is also unconfirmed, not a fresh-generation retry', async () => {
    const fetcher = {
      fetchArrayBuffer: jest.fn().mockResolvedValue(new ArrayBuffer(8)),
    };
    const service = new NovelAiImageGenService(fetcher, getConfig);
    await expect(
      service.generateImage('fixture-token', input()),
    ).rejects.toMatchObject({
      retryable: false,
      outcomeUnknown: true,
    });
    expect(fetcher.fetchArrayBuffer).toHaveBeenCalledTimes(1);
  });

  test('already canceled work is rejected before dispatch and is not marked unconfirmed', async () => {
    const fetcher = {
      fetchArrayBuffer: jest
        .fn()
        .mockRejectedValue(new Error('must not dispatch')),
    };
    const service = new NovelAiImageGenService(fetcher, getConfig);
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.generateImage('fixture-token', {
        ...input(),
        request: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ name: 'AbortError', retryable: false });
    expect(fetcher.fetchArrayBuffer).not.toHaveBeenCalled();
  });

  test.each([500, 502, 503, 504])(
    'HTTP %i cannot prove the paid operation was not executed',
    async (status) => {
      const rejection = createNaiApiError(
        status,
        'upstream failure',
        'fixture-request',
      );
      const fetcher = {
        fetchArrayBuffer: jest.fn().mockRejectedValue(rejection),
      };
      const service = new NovelAiImageGenService(fetcher, getConfig);
      await expect(
        service.generateImage('fixture-token', input()),
      ).rejects.toMatchObject({
        retryable: false,
        outcomeUnknown: true,
        cause: rejection,
      });
      expect(fetcher.fetchArrayBuffer).toHaveBeenCalledTimes(1);
    },
  );

  test('cancel while preparing the wire body is still a known pre-dispatch cancellation', async () => {
    const cancellation = Object.assign(new Error('canceled before fetch'), {
      name: 'AbortError',
      retryable: false,
      outcomeUnknown: false,
    });
    const fetcher = {
      fetchArrayBuffer: jest.fn().mockRejectedValue(cancellation),
    };
    await expect(
      new NovelAiImageGenService(fetcher, getConfig).generateImage(
        'fixture-token',
        input(),
      ),
    ).rejects.toBe(cancellation);
  });

  test('a definite server rejection keeps the known API error and retry decision', async () => {
    const rejection = createNaiApiError(429, 'rate limited');
    const fetcher = {
      fetchArrayBuffer: jest.fn().mockRejectedValue(rejection),
    };
    const service = new NovelAiImageGenService(fetcher, getConfig);
    await expect(service.generateImage('fixture-token', input())).rejects.toBe(
      rejection,
    );
    expect(rejection.retryable).toBe(true);
  });
});
