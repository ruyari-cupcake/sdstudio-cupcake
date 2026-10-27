/** @jest-environment jsdom */
import { readImportFile } from '../fileImportReader';

afterEach(() => jest.restoreAllMocks());

function readerFixture() {
  const reader: any = {
    result: undefined,
    error: undefined,
    onload: null,
    onerror: null,
    onabort: null,
    readAsText: jest.fn(),
    readAsDataURL: jest.fn(),
  };
  jest.spyOn(globalThis, 'FileReader').mockImplementation(() => reader);
  return reader;
}

test('file text resolves only on its read completion and releases callback references', async () => {
  const reader = readerFixture();
  const file = new Blob(['{}']);
  const pending = readImportFile(file, 'text');
  expect(reader.readAsText).toHaveBeenCalledWith(file);
  reader.result = '{}';
  reader.onload();
  await expect(pending).resolves.toBe('{}');
  expect([reader.onload, reader.onerror, reader.onabort]).toEqual([
    null,
    null,
    null,
  ]);
});

test('file read failures settle the import and release the same callbacks', async () => {
  const reader = readerFixture();
  const pending = readImportFile(new Blob(), 'data-url');
  reader.error = new Error('read failed');
  // eslint-disable-next-line jest/valid-expect -- Attach before firing rejection; this assertion is awaited immediately after the event.
  const rejected = expect(pending).rejects.toThrow('read failed');
  reader.onerror();
  await rejected;
  expect([reader.onload, reader.onerror, reader.onabort]).toEqual([
    null,
    null,
    null,
  ]);
});

test('an actual FileReader abort settles as cancellation without a fabricated deadline', async () => {
  const reader = readerFixture();
  const pending = readImportFile(new Blob(), 'data-url');
  // eslint-disable-next-line jest/valid-expect -- Attach before firing cancellation; this assertion is awaited immediately after the event.
  const rejected = expect(pending).rejects.toMatchObject({
    name: 'AbortError',
  });
  reader.onabort();
  await rejected;
  expect([reader.onload, reader.onerror, reader.onabort]).toEqual([
    null,
    null,
    null,
  ]);
});
