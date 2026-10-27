/** @jest-environment node */
/* eslint-disable max-classes-per-file -- The fixture implements the two browser resource classes used together by the decoder. */
import { gzipSync } from 'zlib';
import { TextDecoder, TextEncoder } from 'util';
import { extractMetadataFromAlpha } from '../util';

// The installed Node type declarations predate this available runtime API.
const { DecompressionStream: NodeDecompressionStream } = jest.requireActual(
  'stream/web',
) as {
  DecompressionStream: typeof globalThis.DecompressionStream;
};

const MAGIC = Buffer.from('stealth_pngcomp', 'ascii');
const HEADER_BITS = (MAGIC.length + 4) * 8;
let image: {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  reads: number;
};
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let decompressCalls = 0;

function install(name: string, value: unknown) {
  if (!originalGlobals.has(name))
    originalGlobals.set(
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    );
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}
function fixture(width: number, height: number, encoded = Buffer.alloc(0)) {
  const alpha = new Map<number, number>();
  for (
    let bit = 0;
    bit < Math.min(width * height, encoded.length * 8);
    bit += 1
  ) {
    const x = Math.floor(bit / height);
    const y = bit % height;
    alpha.set(
      (y * width + x) * 4 + 3,
      // eslint-disable-next-line no-bitwise -- Encode the exact least-significant alpha bit of the PNG metadata protocol.
      254 | ((encoded[Math.floor(bit / 8)] >> (7 - (bit % 8))) & 1),
    );
  }
  const value = {
    width,
    height,
    pixels: undefined as unknown as Uint8ClampedArray,
    reads: 0,
  };
  value.pixels = new Proxy(
    { length: width * height * 4 },
    {
      get(target, property) {
        if (property === 'length') return target.length;
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          value.reads += 1;
          return alpha.get(Number(property)) ?? 255;
        }
        return undefined;
      },
    },
  ) as unknown as Uint8ClampedArray;
  image = value;
  return value;
}
function payload(metadata: unknown, declaredBits?: number) {
  const compressed = gzipSync(JSON.stringify(metadata));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(declaredBits ?? compressed.length * 8);
  return {
    encoded: Buffer.concat(
      [MAGIC, length, compressed].map((part) => Uint8Array.from(part)),
    ),
    compressed,
  };
}
function forbidDecompression() {
  install(
    'DecompressionStream',
    class {
      constructor() {
        decompressCalls += 1;
        throw new Error(
          'Invalid payload must be rejected before decompression',
        );
      }
    },
  );
}

beforeEach(() => {
  decompressCalls = 0;
  install('TextEncoder', TextEncoder);
  install('TextDecoder', TextDecoder);
  install('DecompressionStream', NodeDecompressionStream);
  install(
    'Image',
    class {
      width = image.width;

      height = image.height;

      onload?: () => void;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
  install('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error('Unexpected DOM request');
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => ({ data: image.pixels }),
        }),
      };
    },
  });
});
afterEach(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as any)[name];
  }
  originalGlobals.clear();
});

test('a megapixel PNG without stealth metadata reads only the magic header', async () => {
  const f = fixture(1024, 1024);
  expect(await extractMetadataFromAlpha('fixture')).toBeUndefined();
  // eslint-disable-next-line no-console -- Record the measured resource budget alongside its assertions.
  console.info(
    '[alpha-metadata-resources]',
    JSON.stringify({
      pixels: f.width * f.height,
      alphaReads: f.reads,
      previousScratchBytes:
        f.width * f.height + Math.ceil((f.width * f.height) / 8),
    }),
  );
  expect(f.reads).toBeLessThanOrEqual(MAGIC.length * 8);
});

test('column-major alpha payload preserves gzip JSON and its nested Comment object', async () => {
  const expected = {
    Description: 'fixture',
    Comment: { prompt: '한글 prompt', seed: 17 },
  };
  const bytes = payload({
    ...expected,
    Comment: JSON.stringify(expected.Comment),
  });
  fixture(23, 211, bytes.encoded);
  expect(await extractMetadataFromAlpha('fixture')).toEqual(expected);
});

test('a payload occupying the exact available pixel capacity remains valid', async () => {
  const expected = { Comment: { prompt: 'exact capacity' } };
  const bytes = payload(expected);
  fixture(bytes.encoded.length * 8, 1, bytes.encoded);
  expect(await extractMetadataFromAlpha('fixture')).toEqual(expected);
});

test('the legacy bit-length rounding still reads the complete final payload byte', async () => {
  const expected = { Comment: { prompt: 'round final byte' } };
  const normal = payload(expected);
  const bytes = payload(expected, normal.compressed.length * 8 - 1);
  fixture(bytes.encoded.length * 8, 1, bytes.encoded);
  expect(await extractMetadataFromAlpha('fixture')).toEqual(expected);
});

test('an incomplete header is rejected without materializing or scanning all alpha bits', async () => {
  const f = fixture(
    HEADER_BITS - 1,
    1,
    Buffer.concat(
      [MAGIC, Buffer.alloc(4)].map((part) => Uint8Array.from(part)),
    ),
  );
  forbidDecompression();
  expect(await extractMetadataFromAlpha('fixture')).toBeUndefined();
  expect(decompressCalls).toBe(0);
  expect(f.reads).toBe(0);
});

test('a declared payload exceeding actual pixel capacity is rejected before decompression', async () => {
  const bytes = payload({ Comment: { prompt: 'truncated' } });
  const f = fixture(bytes.encoded.length * 8 - 1, 1, bytes.encoded);
  forbidDecompression();
  expect(await extractMetadataFromAlpha('fixture')).toBeUndefined();
  expect(decompressCalls).toBe(0);
  expect(f.reads).toBe(HEADER_BITS);
});

test('a 32-bit length is unsigned and cannot wrap into an apparently empty or short payload', async () => {
  const bytes = payload({ Comment: {} }, 0xffffffff);
  const f = fixture(256, 1, bytes.encoded);
  forbidDecompression();
  expect(await extractMetadataFromAlpha('fixture')).toBeUndefined();
  expect(decompressCalls).toBe(0);
  expect(f.reads).toBe(HEADER_BITS);
});

test('corrupt gzip is a missing-metadata result without leaking an unhandled writer rejection', async () => {
  const length = Buffer.alloc(4);
  const corrupt = Buffer.from([0, 1, 2, 3]);
  length.writeUInt32BE(corrupt.length * 8);
  const bytes = Buffer.concat(
    [MAGIC, length, corrupt].map((part) => Uint8Array.from(part)),
  );
  fixture(bytes.length * 8, 1, bytes);
  expect(await extractMetadataFromAlpha('fixture')).toBeUndefined();
});
