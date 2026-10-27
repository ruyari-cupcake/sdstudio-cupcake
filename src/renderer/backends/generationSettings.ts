import type { Config } from '../../main/config';
import type { SDStudioGenerationSettingsV1 } from '../../shared/sdstudioImageMetadata';
import {
  type GenerationSettingsSnapshot,
  type GenerationQualityPreset,
  type GenerationUcPreset,
  ModelVersion,
} from './imageGen';

const UC_PRESETS: readonly GenerationUcPreset[] = [
  'heavy',
  'light',
  'humanFocus',
  'furryFocus',
  'none',
];

function resolveUcPreset(value: Config['ucPreset']): GenerationUcPreset {
  return value && UC_PRESETS.includes(value) ? value : 'none';
}

const QUALITY_PRESETS: readonly GenerationQualityPreset[] = [
  'standard',
  'light',
  'none',
];

export function resolveQualityPreset(
  config: Pick<Config, 'qualityPreset' | 'disableQuality'>,
): GenerationQualityPreset {
  if (config.qualityPreset && QUALITY_PRESETS.includes(config.qualityPreset)) {
    return config.qualityPreset;
  }
  return config.disableQuality === true ? 'none' : 'standard';
}

export function captureGenerationSettings(
  config: Config,
): GenerationSettingsSnapshot {
  return {
    schemaVersion: 1,
    modelVersion: config.modelVersion ?? ModelVersion.V4_5,
    effort: config.effort === 'medium' ? 'medium' : 'high',
    furryMode: config.furryMode ?? false,
    disableQuality: config.disableQuality ?? false,
    qualityPreset: resolveQualityPreset(config),
    ucPreset: resolveUcPreset(config.ucPreset),
    transparentBackground: config.transparentBackground ?? false,
    autoConvertWebp: config.autoConvertWebp ?? false,
    autoConvertWebpQuality: config.autoConvertWebpQuality ?? 80,
  };
}

/** Restore only the image's model settings; storage/UI preferences stay local. */
export function restoreGenerationSettingsFromImage(
  current: Config,
  saved: SDStudioGenerationSettingsV1,
): Config {
  return {
    ...current,
    modelVersion: saved.modelVersion as ModelVersion,
    effort: saved.effort === 'medium' ? 'medium' : 'high',
    furryMode: saved.furryMode,
    disableQuality: saved.disableQuality,
    qualityPreset: saved.qualityPreset,
    ucPreset: saved.ucPreset as GenerationUcPreset,
    transparentBackground: saved.transparentBackground ?? false,
  };
}
