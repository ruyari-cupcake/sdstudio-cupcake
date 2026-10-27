import {
  type GenerationEffort,
  type GenerationQualityPreset,
  type GenerationSettingsSnapshot,
  type GenerationUcPreset,
  ModelVersion,
} from '../imageGen';
import { getNaiModelSpec } from './naiModelCapabilities';

export type NaiImportedModelSettings = Partial<
  Pick<
    GenerationSettingsSnapshot,
    | 'modelVersion'
    | 'effort'
    | 'qualityPreset'
    | 'disableQuality'
    | 'ucPreset'
    | 'transparentBackground'
  >
>;

const labels: Record<ModelVersion, string> = {
  [ModelVersion.V5]: 'V5 Full',
  [ModelVersion.V5Curated]: 'V5 Curated',
  [ModelVersion.V4_5]: 'V4.5 Full',
  [ModelVersion.V4_5Curated]: 'V4.5 Curated',
  [ModelVersion.V4]: 'V4 Full',
  [ModelVersion.V4Curated]: 'V4 Curated',
};

export function identifyNaiMetadataModel(
  data: any,
  source?: string,
): {
  modelVersion?: ModelVersion;
  effort?: GenerationEffort;
  label: string;
} {
  const text = [source, data?.model, data?.model_name, data?.request_type]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const tokens = new Set(text.split(/[^a-z0-9-]+/));
  let modelVersion: ModelVersion | undefined;
  let effort: GenerationEffort | undefined;
  for (const version of Object.values(ModelVersion)) {
    for (const candidateEffort of version === ModelVersion.V5
      ? (['medium', 'high'] as const)
      : (['high'] as const)) {
      const spec = getNaiModelSpec(version, candidateEffort);
      if (
        tokens.has(spec.generationModelId) ||
        tokens.has(spec.inpaintModelId)
      ) {
        // V5 Curated's fallback wire ID is also a real V4.5 model. Report the
        // actual wire model; params_version 4 alone cannot prove a V5 fallback.
        modelVersion =
          spec.inpaintFallbackVersion && tokens.has(spec.inpaintModelId)
            ? spec.inpaintFallbackVersion
            : version;
        effort = modelVersion === ModelVersion.V5 ? candidateEffort : undefined;
        break;
      }
    }
    if (modelVersion) break;
  }
  if (!modelVersion) {
    const full = /\bfull\b/.test(text);
    const curated = /\bcurated\b/.test(text);
    if (/\bv5\b/.test(text) && (full || curated)) {
      modelVersion = curated ? ModelVersion.V5Curated : ModelVersion.V5;
    } else if (/\bv4[.]5\b/.test(text) && (full || curated)) {
      modelVersion = curated ? ModelVersion.V4_5Curated : ModelVersion.V4_5;
    } else if (/\bv4\b/.test(text) && (full || curated)) {
      modelVersion = curated ? ModelVersion.V4Curated : ModelVersion.V4;
    }
  }
  if (modelVersion === ModelVersion.V5 && !effort) {
    if (data?.effort === 'medium' || /\bmedium\b/.test(text)) effort = 'medium';
    else if (data?.effort === 'high' || /\bhigh\b/.test(text)) effort = 'high';
  }
  let familyLabel = '알 수 없음';
  if (/\bv5\b/.test(text)) familyLabel = 'V5';
  else if (/\bv4[.]5\b/.test(text)) familyLabel = 'V4.5';
  else if (/\bv4\b/.test(text)) familyLabel = 'V4';
  let label = modelVersion ? labels[modelVersion] : familyLabel;
  if (effort === 'medium') label += ' (Medium)';
  if (/inpaint|infill/.test(text)) label += ' 인페인트';
  return { modelVersion, effort, label };
}

/** Restore only explicit metadata; never infer effort from step counts or model hashes. */
export function readNaiImportedModelSettings(
  data: any,
  source?: string,
): NaiImportedModelSettings | undefined {
  const identity = identifyNaiMetadataModel(data, source);
  if (!identity.modelVersion) return undefined;
  const result: NaiImportedModelSettings = {
    modelVersion: identity.modelVersion,
  };
  if (identity.effort) result.effort = identity.effort;
  const quality: GenerationQualityPreset | undefined = [
    'standard',
    'light',
    'none',
  ].includes(data?.qualityPresetId)
    ? data.qualityPresetId
    : undefined;
  if (quality) {
    result.qualityPreset = quality;
    result.disableQuality = quality === 'none';
  }
  const ucIds: Record<string, GenerationUcPreset> = {
    heavy: 'heavy',
    light: 'light',
    human: 'humanFocus',
    furry: 'furryFocus',
    none: 'none',
  };
  if (
    typeof data?.ucPresetId === 'string' &&
    Object.prototype.hasOwnProperty.call(ucIds, data.ucPresetId)
  ) {
    result.ucPreset = ucIds[data.ucPresetId];
  }
  if (typeof data?.tag_hint_transparent_background === 'boolean') {
    result.transparentBackground = data.tag_hint_transparent_background;
  }
  return result;
}
