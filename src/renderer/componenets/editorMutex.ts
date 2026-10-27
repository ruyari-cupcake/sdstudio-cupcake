/** FIFO ownership for imperative prompt editor operations; no timers or retries. */
export default class EditorMutex {
  private queue: Array<() => void> = [];

  private locked = false;

  private acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (!this.locked) this.dispatchNext();
    });
  }

  private dispatchNext(): void {
    const resolve = this.queue.shift();
    this.locked = !!resolve;
    resolve?.();
  }

  async runExclusive<T>(callback: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await callback();
    } finally {
      this.dispatchNext();
    }
  }
}
