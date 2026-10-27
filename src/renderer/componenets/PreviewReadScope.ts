/** Owns preview reads while the containing view changes the files they read. */
export default class PreviewReadScope extends EventTarget {
  private readonly pending = new Set<Promise<unknown>>();

  private pauses = 0;

  get isPaused(): boolean {
    return this.pauses > 0;
  }

  async read<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.isPaused) return null;
    // Register ownership before running the callback, including synchronous errors.
    // A pause in this microtask gap prevents the read from being dispatched at all.
    const result = Promise.resolve().then(() =>
      this.isPaused ? null : work(),
    );
    this.pending.add(result);
    try {
      return await result;
    } finally {
      this.pending.delete(result);
    }
  }

  async whilePaused<T>(operation: () => Promise<T>): Promise<T> {
    this.pauses += 1;
    this.dispatchEvent(new Event('change'));
    try {
      // Wait for every admitted read, including a read whose cell has scrolled
      // away. Rejected previews must not wedge restore/delete operations.
      await Promise.allSettled([...this.pending]);
      return await operation();
    } finally {
      this.pauses -= 1;
      this.dispatchEvent(new Event('change'));
    }
  }
}
