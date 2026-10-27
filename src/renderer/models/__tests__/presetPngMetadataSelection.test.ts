import { Buffer } from 'buffer';
import extractChunks from 'png-chunks-extract';
import encodeChunks from 'png-chunks-encode';
import * as PngChunk from 'png-chunk-text';

jest.mock('..', () => ({}));
jest.mock('../legacy', () => ({}));
jest.mock('../ImageService', () => ({
  dataUriToBase64: (value: string) => value.split(',')[1],
}));
jest.mock('../ResourceSyncService', () => ({
  ResourceSyncService: class extends EventTarget {},
}));
jest.mock('../../defaultassets', () => ({ __esModule: true, default: [] }));

const { embedJSONInPNG, readJSONFromPNG } =
  jest.requireActual<typeof import('../SessionService')>('../SessionService');
const BASE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

function withText(entries: Array<[string, string]>) {
  const chunks = extractChunks(
    Buffer.from(BASE_PNG, 'base64') as unknown as Uint8Array,
  );
  chunks.splice(
    1,
    0,
    ...entries.map(([key, value]) => PngChunk.encode(key, value)),
  );
  return Buffer.from(encodeChunks(chunks)).toString('base64');
}

describe('preset PNG metadata selection', () => {
  it('finds preset data after unrelated textual chunks', () => {
    const preset = { type: 'SDImageGen', name: 'kept', steps: 31 };
    const payload = Buffer.from(JSON.stringify(preset)).toString('base64');
    const png = withText([
      ['Software', 'unrelated encoder'],
      ['Comment', 'ordinary image description'],
      ['tEXt', `json:${payload}`],
    ]);

    expect(readJSONFromPNG(png)).toEqual(preset);
  });

  it('keeps the first marked preset authoritative when its JSON is corrupt', () => {
    const stale = Buffer.from(JSON.stringify({ name: 'stale' })).toString(
      'base64',
    );
    const png = withText([
      ['tEXt', 'json:not-json'],
      ['tEXt', `json:${stale}`],
    ]);

    expect(readJSONFromPNG(png)).toBeUndefined();
  });

  it('returns no preset when no chunk contains a preset marker', () => {
    const png = withText([
      ['Software', 'encoder'],
      ['Comment', '{"name":"text"}'],
    ]);
    expect(readJSONFromPNG(png)).toBeUndefined();
  });

  it('retains the exported-preset roundtrip', () => {
    const preset = {
      type: 'SDImageGenEasy',
      name: 'roundtrip',
      prompt: '<lib.piece>',
    };
    expect(readJSONFromPNG(embedJSONInPNG(BASE_PNG, preset))).toEqual(preset);
  });
});
