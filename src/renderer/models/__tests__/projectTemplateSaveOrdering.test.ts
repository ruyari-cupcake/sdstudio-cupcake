import {
  ProjectTemplateService,
  type IProjectTemplateEntry,
  type ProjectTemplateServiceDependencies,
} from '../ProjectTemplateService';
import { deferred } from '../testSupport/completionMethodHarness';

jest.mock('../types', () => ({
  VibeItem: { fromJSON: (value: unknown) => value },
  ReferenceItem: { fromJSON: (value: unknown) => value },
  CharacterPreset: { fromJSON: (value: unknown) => value },
}));

const template = (id: string): IProjectTemplateEntry => ({
  id,
  name: id,
  createdAt: 1,
  updatedAt: 1,
  preset: null,
  characterPresets: [],
  vibes: [],
  characterReferences: [],
  scenes: [],
});

test('overlapping template saves keep each temp write and replacement together', async () => {
  const firstWrite = deferred<void>();
  const releaseWrite = deferred<void>();
  const files = new Map<string, string>();
  const committed: string[] = [];
  let writes = 0;
  const backend = {
    writeFile: jest.fn(async (filePath: string, data: string) => {
      files.set(filePath, data);
      writes++;
      if (writes === 1) {
        firstWrite.resolve();
        await releaseWrite.promise;
      }
    }),
    renameFile: jest.fn(async (source: string, destination: string) => {
      const data = files.get(source);
      if (data === undefined) throw new Error('ENOENT: missing temporary file');
      files.set(destination, data);
      files.delete(source);
      committed.push(JSON.parse(data).templates[0].id);
    }),
  };
  // This journey uses only the persistence port; other service collaborators
  // must never be invoked by save().
  const service = new ProjectTemplateService({
    backend,
  } as unknown as ProjectTemplateServiceDependencies);

  const first = service.save([template('first')]);
  await firstWrite.promise;
  const second = service.save([template('second')]);
  const third = service.save([template('third')]);
  const settled = Promise.allSettled([first, second, third]);
  releaseWrite.resolve();
  const results = await settled;

  expect(results.map((result) => result.status)).toEqual([
    'fulfilled',
    'fulfilled',
    'fulfilled',
  ]);
  expect(committed).toEqual(['first', 'second', 'third']);
  expect(JSON.parse(files.get('project_templates.json')!).templates).toEqual([
    template('third'),
  ]);
  expect(files.has('project_templates.json.tmp')).toBe(false);
});
