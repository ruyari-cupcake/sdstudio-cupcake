import { Buffer } from 'buffer';

export interface EncodedNaiRequest {
  body: string | ArrayBuffer;
  headers: Record<string, string>;
}

let imageCacheSecret: Promise<CryptoKey> | undefined;

/** The provider's cache key is session scoped; no prompts or image bytes are cached here. */
async function imageCacheKey(base64: string): Promise<string> {
  imageCacheSecret ??= globalThis.crypto.subtle.importKey(
    'raw',
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    await imageCacheSecret,
    new TextEncoder().encode(base64),
  );
  return Buffer.from(signature).toString('hex');
}

function multipartBoundary(): string {
  const random = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `----SDStudioBoundary${Buffer.from(random).toString('hex')}`;
}

/**
 * params_version 4 uses a multipart JSON `request` part and binary image parts.
 * Both platform transports use these exact bytes; legacy params_version 3 and
 * augment/upscale/vibe requests keep their existing JSON contract.
 *
 * Contract corroborated against novelai-python 46e769ce, generate_image's
 * split_image_parts/build_multipart_request and its web-client payload fixtures.
 */
export async function encodeNaiRequest(
  body: any,
  headers: Record<string, string>,
): Promise<EncodedNaiRequest> {
  if (!(Number(body?.parameters?.params_version) >= 4)) {
    return { body: JSON.stringify(body), headers };
  }

  // Preserve the queued snapshot and raw images when replacing them with part names.
  const parameters = { ...body.parameters };
  const request = { ...body, parameters };
  parameters.skip_cfg_above_sigma ??= null;
  const parts = new Map<
    string,
    { name: string; key: string; bytes: Uint8Array }
  >();
  const imagePart = async (base64: string, name: string) => {
    const existing = parts.get(base64);
    if (existing) return existing;
    const part = {
      name,
      key: await imageCacheKey(base64),
      bytes: Uint8Array.from(Buffer.from(base64, 'base64')),
    };
    parts.set(base64, part);
    return part;
  };
  for (const key of ['image', 'mask', 'reference_image']) {
    const value = parameters[key];
    if (typeof value !== 'string' || !value) continue;
    const part = await imagePart(value, key);
    parameters[key] = part.name;
    parameters[`${key}_cache_secret_key`] = part.key;
  }
  for (const [key, prefix] of [
    ['reference_image_multiple', 'ref_multiple_'],
    ['director_reference_images', 'director_ref_'],
  ]) {
    const values = parameters[key];
    delete parameters[key];
    if (!Array.isArray(values) || !values.length) continue;
    const cached = [];
    for (let i = 0; i < values.length; i += 1) {
      const part = await imagePart(values[i], `${prefix}${i}`);
      cached.push({ cache_secret_key: part.key, data: part.name });
    }
    parameters[`${key}_cached`] = cached;
  }

  const boundary = multipartBoundary();
  const chunks: Uint8Array[] = [];
  const utf8 = (value: string) => new TextEncoder().encode(value);
  for (const part of parts.values()) {
    chunks.push(
      utf8(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="blob"\r\n` +
          'Content-Type: image/png\r\n\r\n',
      ),
      part.bytes,
      utf8('\r\n'),
    );
  }
  chunks.push(
    utf8(
      `--${boundary}\r\nContent-Disposition: form-data; name="request"; filename="blob"\r\n` +
        'Content-Type: application/json\r\n\r\n',
    ),
    utf8(JSON.stringify(request)),
    utf8(`\r\n--${boundary}--\r\n`),
  );
  const bytes = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const transportHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => key.toLowerCase() !== 'content-type',
    ),
  );
  transportHeaders['Content-Type'] =
    `multipart/form-data; boundary=${boundary}`;
  return { body: bytes.buffer, headers: transportHeaders };
}
