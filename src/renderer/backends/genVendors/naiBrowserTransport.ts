import type { NovelAiFetcher } from './nai';
import { createNaiApiError } from './naiErrors';
import type { NaiRequestOptions } from '../../models/requestTiming';
import { encodeNaiRequest } from './naiWire';
import throwIfCanceledBeforeDispatch from './naiTransportSupport';

/** Browser transport owns only the HTTP lifetime; paid-result ownership stays in nai.ts. */
export default class BrowserNovelAiFetcher implements NovelAiFetcher {
  constructor(
    private readonly request: typeof fetch = (...args) => fetch(...args),
  ) {}

  async fetchArrayBuffer(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    options?: NaiRequestOptions,
  ): Promise<ArrayBuffer> {
    throwIfCanceledBeforeDispatch(options?.signal);
    const encoded = await encodeNaiRequest(body, headers);
    throwIfCanceledBeforeDispatch(options?.signal);
    const response = await this.request(url, {
      body: encoded.body,
      headers: encoded.headers,
      method: 'POST',
      signal: options?.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const correlationId =
        response.headers.get('x-correlation-id') ??
        response.headers.get('x-request-id') ??
        response.headers.get('cf-ray') ??
        undefined;
      throw createNaiApiError(response.status, detail, correlationId);
    }
    return response.arrayBuffer();
  }
}
