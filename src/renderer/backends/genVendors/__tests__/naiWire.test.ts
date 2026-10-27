import { Buffer } from 'buffer';
import { createHmac, webcrypto } from 'crypto';
import { TextEncoder, TextDecoder } from 'util';
import { encodeNaiRequest } from '../naiWire';
import { BrowserNovelAiFetcher, NativeNovelAiFetcher } from '../naiTransport';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
  Object.assign(globalThis, { TextEncoder, TextDecoder });
  jest
    .spyOn(globalThis.crypto, 'getRandomValues')
    .mockImplementation((values: any) => {
      new Uint8Array(values.buffer, values.byteOffset, values.byteLength).fill(
        17,
      );
      return values;
    });
});

afterAll(() => jest.restoreAllMocks());

const headers = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer fixture-token',
};
const v5Request = () => ({
  model: 'nai-diffusion-5-full-medium',
  action: 'generate',
  input: 'night sky',
  parameters: {
    params_version: 4,
    steps: 14,
    sampler: 'k_euler_ancestral',
    ucPresetId: 'heavy',
    qualityPresetId: 'none',
  },
});

function parseMultipart(body: ArrayBuffer, contentType: string) {
  const boundary = contentType.split('boundary=')[1];
  const chunks = Buffer.from(body).toString('latin1').split(`--${boundary}`);
  const parts = new Map<string, Buffer>();
  for (const chunk of chunks) {
    const separator = chunk.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const name = /name="([^"]+)"/.exec(chunk.slice(0, separator))![1];
    parts.set(name, Buffer.from(chunk.slice(separator + 4, -2), 'latin1'));
  }
  return { parts, request: JSON.parse(parts.get('request')!.toString('utf8')) };
}

describe('params 4 wire contract on both platform transports', () => {
  test('legacy params 3 remains JSON without mutating headers or the input', async () => {
    const legacy = {
      ...v5Request(),
      parameters: { params_version: 3, image: 'fixture' },
    };
    const encoded = await encodeNaiRequest(legacy, headers);
    expect(encoded).toEqual({ body: JSON.stringify(legacy), headers });
  });

  test('generation has a JSON request blob with the exact model and params', async () => {
    const body = v5Request();
    const encoded = await encodeNaiRequest(body, headers);
    const parsed = parseMultipart(
      encoded.body as ArrayBuffer,
      encoded.headers['Content-Type'],
    );
    expect(parsed.parts.size).toBe(1);
    expect(Buffer.from(encoded.body as ArrayBuffer).toString('utf8')).toContain(
      'name="request"; filename="blob"\r\nContent-Type: application/json',
    );
    expect(parsed.request).toEqual({
      ...body,
      parameters: { ...body.parameters, skip_cfg_above_sigma: null },
    });
    expect(headers['Content-Type']).toBe('application/json');
    expect(encoded.headers.Authorization).toBe(headers.Authorization);
  });

  test('inpainting images are raw binary parts with stable session cache keys', async () => {
    const png = Buffer.from([137, 80, 78, 71, 0, 255]);
    const mask = Buffer.from([0, 255, 1, 128]);
    const body = {
      ...v5Request(),
      action: 'infill',
      parameters: {
        ...v5Request().parameters,
        image: png.toString('base64'),
        mask: mask.toString('base64'),
        director_reference_images: [png.toString('base64')],
      },
    };
    const first = await encodeNaiRequest(body, headers);
    const second = await encodeNaiRequest(body, headers);
    const a = parseMultipart(
      first.body as ArrayBuffer,
      first.headers['Content-Type'],
    );
    const b = parseMultipart(
      second.body as ArrayBuffer,
      second.headers['Content-Type'],
    );
    expect(a.parts.get('image')).toEqual(png);
    expect(a.parts.get('mask')).toEqual(mask);
    expect(a.parts.size).toBe(3); // same image reused by reference is not uploaded twice
    expect(a.request.parameters.image).toBe('image');
    expect(a.request.parameters.mask).toBe('mask');
    expect(a.request.parameters.image_cache_secret_key).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(a.request.parameters.image_cache_secret_key).toBe(
      createHmac('sha256', Uint8Array.from(Buffer.alloc(32, 17)))
        .update(png.toString('base64'), 'utf8')
        .digest('hex'),
    );
    expect(a.request.parameters.image_cache_secret_key).toBe(
      b.request.parameters.image_cache_secret_key,
    );
    expect(a.request.parameters.director_reference_images_cached).toEqual([
      {
        cache_secret_key: a.request.parameters.image_cache_secret_key,
        data: 'image',
      },
    ]);
    expect(a.request.parameters).not.toHaveProperty(
      'director_reference_images',
    );
    expect(body.parameters.image).toBe(png.toString('base64'));
  });

  test('browser sends multipart bytes rather than stringifying the binary body', async () => {
    const request = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await new BrowserNovelAiFetcher(request as any).fetchArrayBuffer(
      '/fixture',
      v5Request(),
      headers,
    );
    const options = request.mock.calls[0][1];
    const parsed = parseMultipart(
      options.body,
      options.headers['Content-Type'],
    );
    expect(parsed.request.model).toBe('nai-diffusion-5-full-medium');
    expect(parsed.request.parameters.steps).toBe(14);
  });

  test('Android sends the same multipart contract as base64 with its boundary intact', async () => {
    const bridge = {
      fetchData: jest.fn().mockResolvedValue({ status: 200, data: '' }),
      cancel: jest.fn(),
    };
    await new NativeNovelAiFetcher(
      bridge as any,
      () => 'fixture-id',
    ).fetchArrayBuffer('/fixture', v5Request(), headers);
    const native = bridge.fetchData.mock.calls[0][0];
    const bytes = Uint8Array.from(Buffer.from(native.body, 'base64')).buffer;
    const parsed = parseMultipart(
      bytes,
      JSON.parse(native.headers)['Content-Type'],
    );
    expect(native.bodyEncoding).toBe('base64');
    expect(parsed.request.parameters).toMatchObject({
      params_version: 4,
      ucPresetId: 'heavy',
      qualityPresetId: 'none',
    });
  });
});
