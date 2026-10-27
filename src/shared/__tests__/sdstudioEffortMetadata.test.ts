import { Buffer } from 'buffer';
import {
  type SDStudioImageMetadataV1,
  normalizeSDStudioImageMetadata,
  embedSDStudioMetadataInPngBase64,
  extractSDStudioMetadataFromPngBase64,
  embedSDStudioMetadataInWebpBytes,
  extractSDStudioMetadataFromWebpBytes,
} from '../sdstudioImageMetadata';

const metadata = (): SDStudioImageMetadataV1 => ({
  schemaVersion: 1,
  promptSource: {
    schemaVersion: 1,
    workflowType: 'SDImageGen',
    frontPrompt: 'night sky',
    extraPrompt: '',
    middlePrompt: '',
    backPrompt: '',
  },
  generationSettings: {
    schemaVersion: 1,
    modelVersion: '5-full',
    effort: 'medium',
    furryMode: false,
    disableQuality: false,
    qualityPreset: 'light',
    ucPreset: 'none',
  },
});

describe('effort survives image storage and regeneration metadata', () => {
  test('normalization preserves Medium independently of the saved High UC preference', () => {
    expect(normalizeSDStudioImageMetadata(metadata())).toEqual(metadata());
  });

  test('PNG roundtrip retains the exact generation settings', () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
    const embedded = embedSDStudioMetadataInPngBase64(png, metadata());
    expect(extractSDStudioMetadataFromPngBase64(embedded)).toEqual(metadata());
  });

  test('WebP container roundtrip retains Medium', () => {
    const riff = Buffer.from('524946460400000057454250', 'hex');
    const embedded = embedSDStudioMetadataInWebpBytes(
      Uint8Array.from(riff),
      metadata(),
    );
    expect(extractSDStudioMetadataFromWebpBytes(embedded)).toEqual(metadata());
  });

  test('legacy metadata does not silently turn into Medium and invalid effort is discarded', () => {
    const old = metadata();
    delete old.generationSettings!.effort;
    expect(normalizeSDStudioImageMetadata(old)).toEqual(old);
    const invalid = metadata() as any;
    invalid.generationSettings.effort = 'future-unknown-mode';
    expect(
      normalizeSDStudioImageMetadata(invalid)?.generationSettings,
    ).not.toHaveProperty('effort');
  });
});
