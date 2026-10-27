import {
  restoreGenerationSettingsFromImage,
  captureGenerationSettings,
} from '../generationSettings';
import { ModelVersion } from '../imageGen';
import type { SDStudioGenerationSettingsV1 } from '../../../shared/sdstudioImageMetadata';

const saved = (): SDStudioGenerationSettingsV1 => ({
  schemaVersion: 1,
  modelVersion: '5-full',
  effort: 'medium',
  furryMode: false,
  disableQuality: false,
  qualityPreset: 'light',
  ucPreset: 'humanFocus',
  transparentBackground: true,
});

test('image import restores Medium and keeps output preferences outside model settings', () => {
  const current = {
    effort: 'high' as const,
    autoConvertWebp: true,
    autoConvertWebpQuality: 67,
  };
  const restored = restoreGenerationSettingsFromImage(current, saved());
  expect(restored).toMatchObject({
    effort: 'medium',
    modelVersion: ModelVersion.V5,
    qualityPreset: 'light',
    ucPreset: 'humanFocus',
    transparentBackground: true,
    autoConvertWebp: true,
    autoConvertWebpQuality: 67,
  });
  expect(captureGenerationSettings(restored).effort).toBe('medium');
  expect(current.effort).toBe('high');
});

test('a legacy image restores High instead of inheriting the current Medium toggle', () => {
  const legacy = saved();
  delete legacy.effort;
  const restored = restoreGenerationSettingsFromImage(
    { effort: 'medium' },
    legacy,
  );
  expect(restored.effort).toBe('high');
  expect(captureGenerationSettings(restored).effort).toBe('high');
});
