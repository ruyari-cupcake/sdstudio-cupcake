/** @jest-environment node */
import path from 'path';
import { Buffer } from 'buffer';
import { loadServiceMethods } from '../../models/testSupport/completionMethodHarness';

test.each([
  {
    label: 'landscape constrained by height',
    width: 4000,
    height: 2000,
    maxWidth: 1000,
    maxHeight: 200,
    expectedWidth: 400,
    expectedHeight: 200,
  },
  {
    label: 'portrait uses both independent bounds',
    width: 1000,
    height: 4000,
    maxWidth: 500,
    maxHeight: 1000,
    expectedWidth: 250,
    expectedHeight: 1000,
  },
  {
    label: 'small images are not enlarged',
    width: 40,
    height: 30,
    maxWidth: 400,
    maxHeight: 800,
    expectedWidth: 40,
    expectedHeight: 30,
  },
  {
    label: 'extreme portrait retains one output pixel',
    width: 1,
    height: 4000,
    maxWidth: 20,
    maxHeight: 200,
    expectedWidth: 1,
    expectedHeight: 200,
  },
])(
  '$label',
  async ({
    width,
    height,
    maxWidth,
    maxHeight,
    expectedWidth,
    expectedHeight,
  }) => {
    const resize = jest.fn(async () => undefined);
    const writeFile = jest.fn(async () => undefined);
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../androidBackend.ts'),
      'AndroidBackend',
      ['resizeImage'],
      {
        APP_DIR: 'test-data',
        getDirName: () => 'test-data',
        Filesystem: {
          mkdir: jest.fn(async () => undefined),
          readFile: jest.fn(async () => ({ data: 'AA==' })),
          writeFile,
        },
        Directory: { Documents: 'DOCUMENTS' },
        Image: jest.fn(() => ({
          width,
          height,
          src: '',
          decode: async () => undefined,
        })),
        document: {
          createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: jest.fn() }),
          }),
        },
        pica: {
          resize,
          toBlob: async () => ({
            arrayBuffer: async () => new Uint8Array([1]).buffer,
          }),
        },
        ImageOptimizeMethod: { AVIF: 'avif', LOSSY: 'lossy' },
        Buffer,
      },
    );
    await new Subject().resizeImage({
      inputPath: 'source.png',
      outputPath: 'thumb.png',
      maxWidth,
      maxHeight,
    });
    expect(resize).toHaveBeenCalledWith(
      expect.objectContaining({ width, height }),
      expect.objectContaining({ width: expectedWidth, height: expectedHeight }),
      { unsharpAmount: 160, unsharpRadius: 0.6, unsharpThreshold: 1 },
    );
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'test-data/thumb.png', data: 'AQ==' }),
    );
  },
);
