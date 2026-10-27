/** Retains reusable data within both item and byte budgets; oversized values remain caller-owned. */
function sizeOf(value: unknown): number {
  return typeof value === 'string' ? value.length : 1;
}

export class ImageCache<K, V> {
  totalBytes = 0;

  private readonly entries = new Map<K, V>();

  get cache(): ReadonlyMap<K, V> {
    return this.entries;
  }

  constructor(
    public limit: number,
    public byteLimit?: number,
  ) {}

  get(key: K): V | null {
    if (!this.entries.has(key)) return null;
    const value = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const bytes = sizeOf(value);
    // A single huge original must not turn the cache into an unbounded owner,
    // nor flush the useful thumbnails. Serving the caller does not require caching.
    if (
      this.limit <= 0 ||
      (this.byteLimit !== undefined && bytes > this.byteLimit)
    )
      return;
    this.entries.set(key, value);
    this.totalBytes += bytes;
    while (
      this.entries.size > this.limit ||
      (this.byteLimit !== undefined && this.totalBytes > this.byteLimit)
    ) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: K): void {
    if (!this.entries.has(key)) return;
    this.totalBytes -= sizeOf(this.entries.get(key)!);
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  move(from: K, to: K): void {
    if (from === to) return;
    if (!this.entries.has(from)) {
      // A filesystem rename may replace an already cached destination.
      this.delete(to);
      return;
    }
    const value = this.entries.get(from)!;
    this.delete(from);
    this.set(to, value);
  }
}
