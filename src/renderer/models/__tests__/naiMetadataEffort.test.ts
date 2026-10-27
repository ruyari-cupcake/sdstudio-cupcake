import ExifReader from 'exifreader';
import {
  buildNaiMetadataDiagnostics,
  extractPromptDataFromBase64,
} from '../util';
import { ModelVersion } from '../../backends/imageGen';

jest.mock('exifreader', () => ({
  __esModule: true,
  default: { load: jest.fn() },
}));

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
async function read(data: object, source = 'NovelAI') {
  (ExifReader.load as jest.Mock).mockReturnValue({
    Comment: { value: JSON.stringify(data) },
    Source: { value: source },
  });
  return extractPromptDataFromBase64(png);
}

describe('NovelAI metadata effort identification and import', () => {
  test('an explicit Medium model ID restores effort and params 4 preset IDs', async () => {
    const job = await read({
      prompt: 'night sky',
      model: 'nai-diffusion-5-full-medium',
      params_version: 4,
      steps: 14,
      ucPresetId: 'heavy',
      qualityPresetId: 'none',
      negative_prompt: 'fixed uc',
    });
    expect(job?.naiModelSettings).toMatchObject({
      modelVersion: ModelVersion.V5,
      effort: 'medium',
      ucPreset: 'heavy',
      qualityPreset: 'none',
      disableQuality: true,
    });
    expect(job?.uc).toBe('fixed uc');
    expect(job?.naiDiagnostics?.model).toBe('V5 Full (Medium)');
  });

  test('a High checkpoint with 14 steps remains High', async () => {
    const job = await read({
      prompt: 'night sky',
      model_name: 'nai-diffusion-5-full',
      steps: 14,
    });
    expect(job?.naiModelSettings).toMatchObject({
      modelVersion: ModelVersion.V5,
      effort: 'high',
    });
  });

  test('params 4 does not incorrectly label real V4.5 inpainting as a V5 fallback', () => {
    const result = buildNaiMetadataDiagnostics(
      { params_version: 4, tag_hint_qt: 1, request_type: 'infill' },
      'NovelAI Diffusion V4.5 Curated',
    );
    expect(result.model).toBe('V4.5 Curated 인페인트');
  });

  test('a generic version/hash does not fabricate a checkpoint or effort', async () => {
    const job = await read(
      { prompt: 'night sky', steps: 14, model_hash: '657484a5' },
      'NovelAI Diffusion V5 657484a5',
    );
    expect(job?.naiModelSettings).toBeUndefined();
    expect(job?.naiDiagnostics?.model).toBe('V5');
  });
});
