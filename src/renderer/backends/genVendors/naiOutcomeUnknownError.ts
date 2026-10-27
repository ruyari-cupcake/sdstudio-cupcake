/** A dispatched paid operation whose completion can no longer be established. */
export default class NaiOutcomeUnknownError extends Error {
  readonly retryable = false;

  readonly outcomeUnknown = true;

  readonly cause: unknown;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `NovelAI 요청 결과를 확인할 수 없습니다. 자동 재요청하지 않았습니다.${detail ? ` (${detail})` : ''}`,
    );
    this.name = 'NaiOutcomeUnknownError';
    this.cause = cause;
  }
}
