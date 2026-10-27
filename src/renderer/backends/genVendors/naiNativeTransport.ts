import { Buffer } from 'buffer';
import type { NovelAiFetcher } from './nai';
import { createNaiApiError } from './naiErrors';
import type { NaiRequestOptions } from '../../models/requestTiming';
import { encodeNaiRequest } from './naiWire';
import throwIfCanceledBeforeDispatch from './naiTransportSupport';
import type { NativeNaiBridge } from './naiTransportSupport';

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Android cancellation targets the one native request. Await its real settlement,
 * even after Stop, so a replacement queue cannot overlap the paid operation.
 * Native FetchService has no read/write/call deadline for this boundary.
 */
export default class NativeNovelAiFetcher implements NovelAiFetcher {
  constructor(
    private readonly bridge: NativeNaiBridge,
    private readonly createRequestId: () => string,
  ) {}

  async fetchArrayBuffer(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    options?: NaiRequestOptions,
  ): Promise<ArrayBuffer> {
    const signal = options?.signal;
    throwIfCanceledBeforeDispatch(signal);
    const encoded = await encodeNaiRequest(body, headers);
    throwIfCanceledBeforeDispatch(signal);
    const requestId = this.createRequestId();
    const onAbort = () => {
      this.bridge.cancel({ requestId }).catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfCanceledBeforeDispatch(signal);
      const binaryBody = typeof encoded.body !== 'string';
      const response = await this.bridge.fetchData({
        url,
        body: binaryBody
          ? Buffer.from(encoded.body as ArrayBuffer).toString('base64')
          : (encoded.body as string),
        headers: JSON.stringify(encoded.headers),
        requestId,
        ...(binaryBody ? { bodyEncoding: 'base64' as const } : {}),
      });
      if (response.status < 200 || response.status >= 300) {
        let detail = '';
        try {
          detail = new TextDecoder().decode(decodeBase64(response.data || ''));
        } catch {
          // Preserve the definite HTTP status if the provider body cannot be decoded.
        }
        throw createNaiApiError(
          response.status,
          detail,
          response.correlationId,
        );
      }
      return decodeBase64(response.data);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
