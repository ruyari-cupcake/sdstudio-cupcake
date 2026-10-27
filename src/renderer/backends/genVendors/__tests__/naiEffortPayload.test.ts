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

const getConfig = jest.fn();

function input(): ImageGenInput {
  return {
    model: Model.Anime,
    prompt: 'night sky',
    uc: 'custom negative',
    resolution: { width: 1024, height: 1024 },
    sampling: Sampling.KEuler,
    outputFilePath: 'fixture.png',
    steps: 41,
    promptGuidance: 6,
    cfgRescale: 0.4,
    noiseSchedule: NoiseSchedule.Native,
    vibes: [],
    seed: 123,
    characterPrompts: ['astronaut'],
    characterUCs: ['custom character negative'],
    useCoords: true,
    characterPositions: [{ x: 0.25, y: 0.75 }],
    generationSettings: {
      schemaVersion: 1,
      modelVersion: ModelVersion.V5,
      effort: 'medium',
      furryMode: false,
      disableQuality: false,
      qualityPreset: 'light',
      ucPreset: 'humanFocus',
      transparentBackground: false,
      autoConvertWebp: false,
      autoConvertWebpQuality: 80,
    },
  };
}

async function service() {
  const zip = new JSZip();
  zip.file('image_0.png', new Uint8Array([137, 80, 78, 71]));
  const response = await zip.generateAsync({ type: 'arraybuffer' });
  const fetchArrayBuffer = jest.fn().mockResolvedValue(response);
  return {
    api: new NovelAiImageGenService({ fetchArrayBuffer }, getConfig),
    fetchArrayBuffer,
  };
}

describe('V5 Full effort uses the checkpoint wire contract', () => {
  test.each([
    [Model.Anime, 'nai-diffusion-5-full-medium', 'generate'],
    [Model.I2I, 'nai-diffusion-5-full-medium', 'img2img'],
    [Model.Inpaint, 'nai-diffusion-5-full-medium-inpainting', 'infill'],
  ])(
    'Medium %s fixes sampling and UC without overwriting stored High settings',
    async (model, modelId, action) => {
      const params = input();
      params.model = model as Model;
      if (model !== Model.Anime) params.image = 'aW1hZ2U=';
      if (model === Model.Inpaint) params.mask = 'bWFzaw==';
      const before = JSON.parse(JSON.stringify(params));
      const { api, fetchArrayBuffer } = await service();
      await api.generateImage('fixture-token', params);
      const body = fetchArrayBuffer.mock.calls[0][1];
      expect(body).toMatchObject({
        model: modelId,
        action,
        parameters: {
          params_version: 4,
          sampler: 'k_euler_ancestral',
          steps: 14,
          cfg_rescale: 0,
          scale: 6,
          noise_schedule: 'karras',
          ucPresetId: 'heavy',
          qualityPresetId: 'light',
          image_format: 'png',
          straight_alpha: true,
          tag_hint_uc_preset: 2,
        },
      });
      expect(body.parameters.negative_prompt).toContain('lowres');
      expect(body.parameters.negative_prompt).not.toContain('custom negative');
      expect(body.parameters.v4_negative_prompt.caption.base_caption).toBe(
        body.parameters.negative_prompt,
      );
      expect(body.parameters.characterPrompts[0]).toEqual({
        prompt: 'astronaut',
        uc: '',
        center: { x: 0.25, y: 0.75 },
      });
      expect(
        body.parameters.v4_negative_prompt.caption.char_captions[0]
          .char_caption,
      ).toBe('');
      expect(params).toEqual(before);
    },
  );

  test('High retains custom UC, CFG rescale, steps and sampler with current preset IDs', async () => {
    const params = input();
    params.generationSettings!.effort = 'high';
    const { api, fetchArrayBuffer } = await service();
    await api.generateImage('fixture-token', params);
    const body = fetchArrayBuffer.mock.calls[0][1];
    expect(body).toMatchObject({
      model: 'nai-diffusion-5-full',
      parameters: {
        params_version: 4,
        sampler: 'k_euler',
        steps: 41,
        cfg_rescale: 0.4,
        ucPresetId: 'human',
        qualityPresetId: 'light',
        image_format: 'png',
        straight_alpha: true,
      },
    });
    expect(body.parameters.negative_prompt).toContain('custom negative');
    expect(body.parameters.characterPrompts[0].uc).toBe(
      'custom character negative',
    );
  });

  test('Curated ignores a stored Full Medium preference', async () => {
    const params = input();
    params.generationSettings!.modelVersion = ModelVersion.V5Curated;
    const { api, fetchArrayBuffer } = await service();
    await api.generateImage('fixture-token', params);
    const body = fetchArrayBuffer.mock.calls[0][1];
    expect(body.model).toBe('nai-diffusion-5-curated');
    expect(body.parameters.steps).toBe(41);
    expect(body.parameters.negative_prompt).toContain('custom negative');
  });
});

describe('reference and vibe compatibility at the final paid boundary', () => {
  const reference = {
    image: 'cmVm',
    info: 1,
    strength: -0.2,
    fidelity: -0.3,
    description: 'fixture',
    referenceType: 'style' as const,
  };

  test('V4.5 Precise Reference preserves style/strength/fidelity and takes precedence over Vibe', async () => {
    const params = input();
    params.generationSettings!.modelVersion = ModelVersion.V4_5;
    params.characterReferences = [reference];
    params.vibes = [{ image: 'dmliZQ==', info: 0.8, strength: 0.5 }];
    const { api, fetchArrayBuffer } = await service();
    await api.generateImage('fixture-token', params);
    const p = fetchArrayBuffer.mock.calls[0][1].parameters;
    expect(p.director_reference_descriptions[0].caption.base_caption).toBe(
      'style',
    );
    expect(p.director_reference_strength_values).toEqual([-0.2]);
    expect(p.director_reference_secondary_strength_values[0]).toBeCloseTo(1.3);
    expect(p).not.toHaveProperty('reference_image_multiple');
    expect(params.vibes).toHaveLength(1);
  });

  test('V4 retains Vibe and excludes unsupported Precise Reference', async () => {
    const params = input();
    params.generationSettings!.modelVersion = ModelVersion.V4;
    params.characterReferences = [reference];
    params.vibes = [{ image: 'dmliZQ==', info: 1, strength: 0.5 }];
    const { api, fetchArrayBuffer } = await service();
    await api.generateImage('fixture-token', params);
    const p = fetchArrayBuffer.mock.calls[0][1].parameters;
    expect(p).not.toHaveProperty('director_reference_images');
    expect(p.reference_image_multiple).toEqual(['dmliZQ==']);
  });

  test('V5 omits both unsupported image features but retains the saved inputs', async () => {
    const params = input();
    params.characterReferences = [reference];
    params.vibes = [{ image: 'dmliZQ==', info: 1, strength: 0.5 }];
    const { api, fetchArrayBuffer } = await service();
    await api.generateImage('fixture-token', params);
    const p = fetchArrayBuffer.mock.calls[0][1].parameters;
    expect(p).not.toHaveProperty('director_reference_images');
    expect(p).not.toHaveProperty('reference_image_multiple');
    expect(params.characterReferences).toEqual([reference]);
    expect(params.vibes).toHaveLength(1);
  });

  test('zero-strength normalization remains finite instead of serializing NaN as null', async () => {
    const params = input();
    params.generationSettings!.modelVersion = ModelVersion.V4_5;
    params.normalizeStrength = true;
    params.vibes = [
      { image: 'YQ==', info: 1, strength: 0 },
      { image: 'Yg==', info: 1, strength: 0 },
    ];
    const { api, fetchArrayBuffer } = await service();
    await api.generateImage('fixture-token', params);
    expect(
      fetchArrayBuffer.mock.calls[0][1].parameters.reference_strength_multiple,
    ).toEqual([0, 0]);
  });

  test('more than the provider-supported 16 Vibes is rejected before dispatch', async () => {
    const params = input();
    params.generationSettings!.modelVersion = ModelVersion.V4_5;
    params.vibes = Array.from({ length: 17 }, () => ({
      image: 'YQ==',
      info: 1,
      strength: 0.1,
    }));
    const { api, fetchArrayBuffer } = await service();
    await expect(
      api.generateImage('fixture-token', params),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchArrayBuffer).not.toHaveBeenCalled();
    expect(params.vibes).toHaveLength(17);
  });
});

describe('paid Vibe encoder uses the queued model', () => {
  test('an explicit V4.5 encoding request does not inherit a newly selected V5 global model', async () => {
    getConfig.mockResolvedValue({
      modelVersion: ModelVersion.V5,
    });
    const { api, fetchArrayBuffer } = await service();
    await api.encodeVibeImage('fixture-token', {
      image: 'YQ==',
      info: 0.8,
      modelVersion: ModelVersion.V4_5,
    });
    expect(fetchArrayBuffer.mock.calls[0][1]).toMatchObject({
      model: 'nai-diffusion-4-5-full',
      information_extracted: 0.8,
    });
  });

  test('unsupported V5 encoding is rejected without a paid dispatch', async () => {
    getConfig.mockResolvedValue({
      modelVersion: ModelVersion.V5,
    });
    const { api, fetchArrayBuffer } = await service();
    await expect(
      api.encodeVibeImage('fixture-token', {
        image: 'YQ==',
        info: 1,
        modelVersion: ModelVersion.V5,
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchArrayBuffer).not.toHaveBeenCalled();
  });
});
