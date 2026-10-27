/** @jest-environment jsdom */
import { getImportFilePath } from '../importFilePath';

test('native import asks the preload capability for the actual selected File', () => {
  const file = new File(['backup'], 'project.tar');
  const bridge = { getPathForFile: jest.fn(() => '/selected/project.tar') };
  expect(getImportFilePath(file, bridge)).toBe('/selected/project.tar');
  expect(bridge.getPathForFile).toHaveBeenCalledWith(file);
});

test('ordinary browser and mobile files do not invent a native path', () => {
  const file = new File(['backup'], 'project.tar');
  expect(getImportFilePath(file, {})).toBeUndefined();
});

test('synthetic files with no filesystem backing leave the existing unsupported-path flow intact', () => {
  const file = new File(['backup'], 'project.tar');
  expect(getImportFilePath(file, { getPathForFile: () => '' })).toBeUndefined();
});

test('a rejected File argument settles as an unavailable path', () => {
  expect(
    getImportFilePath({ name: 'project.tar' } as File, {
      getPathForFile: () => {
        throw new TypeError('Expected a File');
      },
    }),
  ).toBeUndefined();
});
