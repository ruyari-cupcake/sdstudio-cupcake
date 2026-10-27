/** @jest-environment node */
import path from 'path';
import { loadServiceMethods } from '../testSupport/completionMethodHarness';

test('installing LocalAI preserves other model owners in the shared models directory', async () => {
  const files = new Map([
    ['models/kaloscope/model.onnx', 'installed Kaloscope weights'],
    ['models/wd/model.onnx', 'installed WD weights'],
    ['models/wd/tags.csv', 'installed tag labels'],
    ['models/quality', 'previous LocalAI weights'],
    ['localai/previous-runtime', 'previous LocalAI executable'],
    ['tmp/localai.zip', 'previous installer'],
  ]);
  const backend = {
    deleteFile: jest.fn(async (file: string) => {
      files.delete(file);
    }),
    deleteDir: jest.fn(async (directory: string) => {
      for (const file of files.keys()) {
        if (file === directory || file.startsWith(`${directory}/`))
          files.delete(file);
      }
    }),
    download: jest.fn(
      async (_url: string, directory: string, filename: string) => {
        files.set(`${directory}/${filename}`, `downloaded ${filename}`);
      },
    ),
    extractZip: jest.fn(async () => {
      files.set('localai/runtime', 'new executable');
    }),
  };
  const Subject = loadServiceMethods(
    path.resolve(__dirname, '../LocalAIService.ts'),
    'LocalAIService',
    ['download'],
    {
      backend,
      platform: { supportsRemoveBg: true },
      getLocalAIDownloadLink: async () => 'fixture:localai',
      QUALITY_DOWNLOAD_LINK: 'fixture:quality',
      CustomEvent,
      console,
    },
  );
  const subject = new Subject();
  // This assignment also exercises constructor-DI versions of the same production method.
  subject.backend = backend;
  subject.dispatchEvent = jest.fn();
  subject.statsModels = jest.fn(async () => undefined);
  await subject.download();

  expect(files.get('models/kaloscope/model.onnx')).toBe(
    'installed Kaloscope weights',
  );
  expect(files.get('models/wd/model.onnx')).toBe('installed WD weights');
  expect(files.get('models/wd/tags.csv')).toBe('installed tag labels');
  expect(files.get('models/quality')).toBe('downloaded quality');
  expect(files.get('localai/runtime')).toBe('new executable');
  expect(backend.deleteDir).not.toHaveBeenCalledWith('models');
  expect(subject.statsModels).toHaveBeenCalledTimes(1);
  expect(subject.downloading).toBe(false);
});
