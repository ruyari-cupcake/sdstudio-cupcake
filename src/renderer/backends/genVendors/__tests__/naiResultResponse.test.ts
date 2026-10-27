import { Buffer } from 'buffer';
import JSZip from 'jszip';
import { NovelAiImageGenService } from '../nai';
import {
  type ImageGenInput,
  Model,
  ModelVersion,
  NoiseSchedule,
  Sampling,
} from '../../imageGen';

jest.mock('../../imageDimensions', () => ({
  __esModule: true,
  default: jest.fn(),
}));
jest.mock('libsodium-wrappers-sumo', () => ({ ready: Promise.resolve() }));

const getConfig = jest.fn(async () => {
  throw new Error('This fixture must not read live generation config');
});

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
const input: ImageGenInput = {
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
    effort: 'high',
    furryMode: false,
    disableQuality: true,
    ucPreset: 'none',
    autoConvertWebp: false,
    autoConvertWebpQuality: 80,
  },
};

test('a direct PNG paid response is delivered without requiring a ZIP envelope', async () => {
  const fetchArrayBuffer = jest
    .fn()
    .mockResolvedValue(Uint8Array.from(Buffer.from(png, 'base64')).buffer);
  const api = new NovelAiImageGenService({ fetchArrayBuffer }, getConfig);
  await expect(api.generateImage('fixture-token', input)).resolves.toBe(png);
  expect(fetchArrayBuffer).toHaveBeenCalledTimes(1);
});

test('ZIP metadata or directory entries cannot be saved as the generated image', async () => {
  const zip = new JSZip();
  zip.file('manifest.json', '{"status":"complete"}');
  zip.folder('images');
  zip.file('images/image_0.png', png, { base64: true });
  const fetchArrayBuffer = jest
    .fn()
    .mockResolvedValue(await zip.generateAsync({ type: 'arraybuffer' }));
  const api = new NovelAiImageGenService({ fetchArrayBuffer }, getConfig);
  await expect(api.generateImage('fixture-token', input)).resolves.toBe(png);
  expect(fetchArrayBuffer).toHaveBeenCalledTimes(1);
});

test('an archive without the requested PNG is unconfirmed and must not trigger regeneration', async () => {
  const zip = new JSZip();
  zip.file('manifest.json', '{}');
  const fetchArrayBuffer = jest
    .fn()
    .mockResolvedValue(await zip.generateAsync({ type: 'arraybuffer' }));
  const api = new NovelAiImageGenService({ fetchArrayBuffer }, getConfig);
  await expect(api.generateImage('fixture-token', input)).rejects.toMatchObject(
    {
      retryable: false,
      outcomeUnknown: true,
    },
  );
  expect(fetchArrayBuffer).toHaveBeenCalledTimes(1);
});
