export interface NativeNaiBridge {
  fetchData(options: {
    url: string;
    body: string;
    headers: string;
    requestId?: string;
    bodyEncoding?: 'base64';
  }): Promise<{ data: string; status: number; correlationId?: string }>;
  cancel(options: { requestId: string }): Promise<void>;
}

export default function throwIfCanceledBeforeDispatch(
  signal?: AbortSignal,
): void {
  if (!signal?.aborted) return;
  throw Object.assign(new Error('요청이 취소되었습니다.'), {
    name: 'AbortError',
    retryable: false,
    outcomeUnknown: false,
  });
}
