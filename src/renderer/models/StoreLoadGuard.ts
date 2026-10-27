/**
 * One explicit load owns recovery; writes stay blocked until it completes.
 * An unsuccessful load retains its original error and never schedules a retry.
 */
export class StoreLoadGuard {
  private state: 'ready' | 'loading' | 'failed' = 'ready';

  private failure: unknown;

  private inFlight: Promise<void> | undefined;

  run(load: () => Promise<void>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.state = 'loading';
    this.failure = undefined;
    const task = Promise.resolve()
      .then(load)
      .then(
        () => {
          this.state = 'ready';
          return undefined;
        },
        (error: unknown) => {
          this.state = 'failed';
          this.failure = error;
          throw error;
        },
      )
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = task;
    return task;
  }

  assertWritable(): void {
    if (this.state === 'failed') throw this.failure;
    if (this.state === 'loading') {
      throw new Error('목록을 불러오는 중에는 저장할 수 없습니다.');
    }
  }
}
