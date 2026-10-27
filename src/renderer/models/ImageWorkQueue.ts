/** Bounds transient image buffers. Every admitted caller finishes; there is no expiry or drop policy. */
export class ImageWorkQueue {
  private active = 0;

  private pending: Array<() => void> = [];

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Image work concurrency must be a positive integer');
    }
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active += 1;
        Promise.resolve()
          .then(work)
          .then(resolve, reject)
          .finally(() => {
            this.active -= 1;
            this.pending.shift()?.();
          })
          .catch(reject);
      };
      if (this.active < this.concurrency) start();
      else this.pending.push(start);
    });
  }
}
