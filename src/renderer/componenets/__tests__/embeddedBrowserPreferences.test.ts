import path from 'path';
import loadComponentFixture from '../testSupport/componentFixture';

const source = path.resolve(__dirname, '../EmbeddedBrowser.tsx');
const defaults = [
  { id: 'default', label: 'Default', url: 'https://example.com' },
];

test.each([{}, null, [{ label: 'missing ID and URL' }]])(
  'malformed stored bookmark structure cannot replace the renderable default list: %j',
  (stored) => {
    const loadBookmarks = loadComponentFixture(source, 'loadBookmarks', {
      localStorage: { getItem: () => JSON.stringify(stored) },
      DEFAULT_BOOKMARKS: defaults,
      BOOKMARKS_KEY: 'sdstudio-browser-bookmarks',
    }) as unknown as () => unknown;
    expect(loadBookmarks()).toEqual(defaults);
  },
);

test('valid bookmark entries survive beside malformed stored entries', () => {
  const saved = { id: 'saved', label: 'Saved', url: 'https://example.org' };
  const loadBookmarks = loadComponentFixture(source, 'loadBookmarks', {
    localStorage: { getItem: () => JSON.stringify([saved, null, 42, {}]) },
    DEFAULT_BOOKMARKS: defaults,
    BOOKMARKS_KEY: 'sdstudio-browser-bookmarks',
  }) as unknown as () => unknown;
  expect(loadBookmarks()).toEqual([saved]);
});

test.each([
  [
    'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36 Electron/40.0.0 sdstudio/1.0',
    'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36',
  ],
  [
    'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
  ],
  [undefined, ''],
])(
  'guest user agent derives from the actual runtime: %s',
  (userAgent, expected) => {
    const value = loadComponentFixture(source, 'CLEAN_USER_AGENT', {
      navigator: userAgent === undefined ? undefined : { userAgent },
    }) as unknown as string;
    expect(value).toBe(expected);
  },
);
