import { captureGenerationSettings } from '../generationSettings';
import { Model, ModelVersion, Sampling } from '../imageGen';
import {
  getNaiModelSpec,
  normalizeNaiSampling,
  resolveNaiModelId,
} from '../genVendors/naiModelCapabilities';

describe('NovelAI effort contract (official release 2026-10-08)', () => {
  test('a queued generation keeps selected effort after settings change', () => {
    const config = {
      modelVersion: ModelVersion.V5,
      effort: 'medium',
    } as Parameters<typeof captureGenerationSettings>[0];
    const queued = captureGenerationSettings(config);
    config.effort = 'high';
    expect(queued.effort).toBe('medium');
    expect(captureGenerationSettings(config).effort).toBe('high');
    expect(captureGenerationSettings({} as typeof config).effort).toBe('high');
  });

  test('Medium selects distilled Full checkpoints for generation and inpaint', () => {
    expect(resolveNaiModelId(Model.Anime, ModelVersion.V5, 'medium')).toBe(
      'nai-diffusion-5-full-medium',
    );
    expect(resolveNaiModelId(Model.I2I, ModelVersion.V5, 'medium')).toBe(
      'nai-diffusion-5-full-medium',
    );
    expect(resolveNaiModelId(Model.Inpaint, ModelVersion.V5, 'medium')).toBe(
      'nai-diffusion-5-full-medium-inpainting',
    );
    expect(resolveNaiModelId(Model.Anime, ModelVersion.V5)).toBe(
      'nai-diffusion-5-full',
    );
  });

  test('Medium has the published fixed sampling and unsupported-control contract', () => {
    const medium = getNaiModelSpec(ModelVersion.V5, 'medium').capabilities;
    expect(medium.fixedSteps).toBe(14);
    expect(medium.supportedSamplers).toEqual([Sampling.KEulerAncestral]);
    expect(medium.supportsNegativePrompt).toBe(false);
    expect(medium.supportsCfgRescale).toBe(false);
    expect(
      normalizeNaiSampling(ModelVersion.V5, Sampling.KDPMPP2M, 'medium'),
    ).toBe(Sampling.KEulerAncestral);
    expect(
      getNaiModelSpec(ModelVersion.V5).capabilities.supportsNegativePrompt,
    ).toBe(true);
  });

  test('stored effort does not turn Curated or older models into Full Medium', () => {
    for (const version of [
      ModelVersion.V5Curated,
      ModelVersion.V4_5,
      ModelVersion.V4,
    ]) {
      expect(getNaiModelSpec(version, 'medium')).toEqual(
        getNaiModelSpec(version, 'high'),
      );
    }
    expect(
      getNaiModelSpec(ModelVersion.V4).capabilities.supportsCharacterReference,
    ).toBe(false);
    expect(
      getNaiModelSpec(ModelVersion.V4_5).capabilities
        .supportsCharacterReference,
    ).toBe(true);
  });
});
