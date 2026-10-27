import { compareReleaseVersions, readUpdateManifest } from '../appUpdate';

const expected = {
  channel: 'private' as const,
  appId: 'io.example.private',
  version: '6.1.0-cupcake.1',
};
const manifest = () => ({
  schema: 1,
  ...expected,
  assets: [
    {
      kind: 'windows-portable',
      name: 'Example.exe',
      size: 42,
      sha256: 'a'.repeat(64),
    },
    {
      kind: 'windows-folder',
      name: 'Example.zip',
      size: 24,
      sha256: 'b'.repeat(64),
    },
    {
      kind: 'android-apk',
      name: 'Example.apk',
      size: 12,
      sha256: 'c'.repeat(64),
    },
  ],
});

describe('release version ordering', () => {
  test.each([
    ['6.1.0-cupcake.1', '6.0.0-cupcake.6', 1],
    ['6.0.0-cupcake.10', '6.0.0-cupcake.9', 1],
    ['6.0.0-cupcake.2', '6.0.0-cupcake.10', -1],
    ['6.0.0', '6.0.0-cupcake.10', 1],
    ['6.0.0+build2', '6.0.0+build1', 0],
    ['6.0.0-a.1', '6.0.0-a.beta', -1],
    ['6.0.0-cupcake.1', '6.0.0-cupcake.1', 0],
  ])('%s versus %s', (left, right, order) => {
    expect(compareReleaseVersions(left, right)).toBe(order);
  });
  test.each(['v6.0.0', '6.0', '../release', '6.01.0', '6.0.0-cupcake.01'])(
    'rejects invalid version %s',
    (value) => {
      expect(() => compareReleaseVersions(value, '6.0.0')).toThrow();
    },
  );
});

describe('release manifest boundary', () => {
  test('accepts exact build channel, identity and tag with all platform assets', () => {
    expect(readUpdateManifest(manifest(), expected)).toEqual(manifest());
  });
  test.each([
    ['channel', 'public'],
    ['appId', 'io.example.public'],
    ['version', '6.0.0-cupcake.9'],
    ['schema', 2],
  ])(
    'rejects a mismatched %s without falling back to another release',
    (key, value) => {
      expect(() =>
        readUpdateManifest({ ...manifest(), [key]: value }, expected),
      ).toThrow();
    },
  );
  test.each([
    '../Example.exe',
    'folder/Example.exe',
    'C:\\Example.exe',
    '.',
    '..',
  ])('rejects a release asset name that is not a basename: %s', (name) => {
    const value = manifest();
    value.assets[0].name = name;
    expect(() => readUpdateManifest(value, expected)).toThrow();
  });
  test.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unusable download size %s',
    (size) => {
      const value = manifest();
      value.assets[0].size = size;
      expect(() => readUpdateManifest(value, expected)).toThrow();
    },
  );
  test('rejects duplicate kinds, duplicate names, missing platforms and bad hashes', () => {
    const duplicateKind = manifest();
    duplicateKind.assets[1].kind = 'windows-portable';
    const duplicateName = manifest();
    duplicateName.assets[1].name = duplicateName.assets[0].name;
    const badHash = manifest();
    badHash.assets[0].sha256 = 'not-a-checksum';
    for (const value of [
      duplicateKind,
      duplicateName,
      badHash,
      { ...manifest(), assets: [] },
    ]) {
      expect(() => readUpdateManifest(value, expected)).toThrow();
    }
  });
});
