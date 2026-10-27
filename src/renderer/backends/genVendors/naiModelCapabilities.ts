import {
  type GenerationEffort,
  Model,
  ModelVersion,
  NoiseSchedule,
  Sampling,
} from '../imageGen';

export interface NaiModelCapabilities {
  paramsVersion: 3 | 4;
  supportedSamplers: readonly Sampling[];
  maxPromptGuidance?: number;
  maxSteps?: number;
  fixedSteps?: number;
  supportsNegativePrompt: boolean;
  supportsCfgRescale: boolean;
  maxCharacterPrompts?: number;
  promptTokenLimit?: number;
  supportsVibeTransfer: boolean;
  maxVibeImages?: number;
  supportsCharacterReference: boolean;
  supportsVarietyPlus: boolean;
  supportsTransparentBackground: boolean;
  forcedNoiseSchedule?: NoiseSchedule;
}

export interface NaiModelSpec {
  version: ModelVersion;
  generationModelId: string;
  inpaintModelId: string;
  inpaintFallbackVersion?: ModelVersion;
  capabilities: NaiModelCapabilities;
}

const LEGACY_SAMPLERS: readonly Sampling[] = [
  Sampling.KEulerAncestral,
  Sampling.KEuler,
  Sampling.KDPMPP2SAncestral,
  Sampling.KDPMPP2M,
  Sampling.KDPMPPSDE,
  Sampling.KDPMPP2MSDE,
  Sampling.DDIM,
];

export const V5_SAMPLERS: readonly Sampling[] = [
  Sampling.KEulerAncestral,
  Sampling.KEuler,
  Sampling.KDPMPP2SAncestral,
  Sampling.KDPMPP2MSDE,
  Sampling.KDPMPP2M,
  Sampling.KDPMPPSDE,
];

const legacyCapabilities = (): NaiModelCapabilities => ({
  paramsVersion: 3,
  supportedSamplers: LEGACY_SAMPLERS,
  supportsNegativePrompt: true,
  supportsCfgRescale: true,
  supportsVibeTransfer: true,
  maxVibeImages: 16,
  supportsCharacterReference: true,
  supportsVarietyPlus: true,
  supportsTransparentBackground: false,
});

const v5Capabilities = (promptTokenLimit: number): NaiModelCapabilities => ({
  paramsVersion: 4,
  supportedSamplers: V5_SAMPLERS,
  supportsNegativePrompt: true,
  supportsCfgRescale: true,
  maxPromptGuidance: 10,
  maxSteps: 50,
  maxCharacterPrompts: 32,
  promptTokenLimit,
  supportsVibeTransfer: false,
  supportsCharacterReference: false,
  supportsVarietyPlus: false,
  supportsTransparentBackground: true,
  forcedNoiseSchedule: NoiseSchedule.Karras,
});

export const NAI_MODEL_SPECS: Readonly<Record<ModelVersion, NaiModelSpec>> = {
  [ModelVersion.V5]: {
    version: ModelVersion.V5,
    generationModelId: 'nai-diffusion-5-full',
    inpaintModelId: 'nai-diffusion-5-full-inpainting',
    capabilities: v5Capabilities(1471),
  },
  [ModelVersion.V5Curated]: {
    version: ModelVersion.V5Curated,
    generationModelId: 'nai-diffusion-5-curated',
    inpaintModelId: 'nai-diffusion-4-5-curated-inpainting',
    inpaintFallbackVersion: ModelVersion.V4_5Curated,
    capabilities: v5Capabilities(703),
  },
  [ModelVersion.V4_5]: {
    version: ModelVersion.V4_5,
    generationModelId: 'nai-diffusion-4-5-full',
    inpaintModelId: 'nai-diffusion-4-5-full-inpainting',
    capabilities: legacyCapabilities(),
  },
  [ModelVersion.V4_5Curated]: {
    version: ModelVersion.V4_5Curated,
    generationModelId: 'nai-diffusion-4-5-curated',
    inpaintModelId: 'nai-diffusion-4-5-curated-inpainting',
    capabilities: legacyCapabilities(),
  },
  [ModelVersion.V4]: {
    version: ModelVersion.V4,
    generationModelId: 'nai-diffusion-4-full',
    inpaintModelId: 'nai-diffusion-4-full-inpainting',
    capabilities: {
      ...legacyCapabilities(),
      supportsCharacterReference: false,
    },
  },
  [ModelVersion.V4Curated]: {
    version: ModelVersion.V4Curated,
    generationModelId: 'nai-diffusion-4-curated-preview',
    inpaintModelId: 'nai-diffusion-4-curated-inpainting',
    capabilities: {
      ...legacyCapabilities(),
      supportsCharacterReference: false,
    },
  },
};

// Medium is a separately distilled checkpoint with a published sampling contract.
// Do not mutate the user's stored High settings when selecting it.
const V5_MEDIUM_SPEC: NaiModelSpec = {
  ...NAI_MODEL_SPECS[ModelVersion.V5],
  generationModelId: 'nai-diffusion-5-full-medium',
  inpaintModelId: 'nai-diffusion-5-full-medium-inpainting',
  capabilities: {
    ...NAI_MODEL_SPECS[ModelVersion.V5].capabilities,
    supportedSamplers: [Sampling.KEulerAncestral],
    fixedSteps: 14,
    supportsNegativePrompt: false,
    supportsCfgRescale: false,
  },
};

export function getNaiModelSpec(
  version: ModelVersion,
  effort: GenerationEffort = 'high',
): NaiModelSpec {
  const spec =
    version === ModelVersion.V5 && effort === 'medium'
      ? V5_MEDIUM_SPEC
      : NAI_MODEL_SPECS[version];
  if (!spec) throw new Error(`지원하지 않는 NAI 모델 버전: ${version}`);
  return spec;
}

export function resolveNaiModelId(
  model: Model,
  version: ModelVersion,
  effort: GenerationEffort = 'high',
): string {
  const spec = getNaiModelSpec(version, effort);
  return model === Model.Inpaint ? spec.inpaintModelId : spec.generationModelId;
}

export function isV5ModelVersion(version: ModelVersion): boolean {
  return version === ModelVersion.V5 || version === ModelVersion.V5Curated;
}

export function normalizeNaiSampling(
  version: ModelVersion,
  sampling: Sampling,
  effort: GenerationEffort = 'high',
): Sampling {
  const supported = getNaiModelSpec(version, effort).capabilities
    .supportedSamplers;
  return supported.includes(sampling) ? sampling : Sampling.KEulerAncestral;
}

/** Opus 무료 생성 픽셀 상한(1MP = 1024×1024) — 무료 판정·미러 캔버스 축소·인페인트 해상도 안내 공용. */
export const NAI_FREE_PIXEL_LIMIT = 1_048_576;

export interface OpusFreeEligibilityInput {
  version: ModelVersion;
  width: number;
  height: number;
  steps: number;
  hasCharacterReference: boolean;
}

export function isOpusFreeEligible({
  version,
  width,
  height,
  steps,
  hasCharacterReference,
}: OpusFreeEligibilityInput): boolean {
  return (
    isV5ModelVersion(version) &&
    !hasCharacterReference &&
    width * height <= NAI_FREE_PIXEL_LIMIT &&
    steps <= 28
  );
}
