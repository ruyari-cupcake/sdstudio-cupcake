export class TaskTimeEstimator {
  samples: (number | undefined)[];

  cursor: number;

  maxSamples: number;

  defaultEstimate: number;

  constructor(maxSamples: number, defaultEstimate: number) {
    this.samples = new Array(maxSamples);
    this.maxSamples = maxSamples;
    this.cursor = 0;
    this.defaultEstimate = defaultEstimate;
  }

  addSample(time: number) {
    this.samples[this.cursor] = time;
    this.cursor = (this.cursor + 1) % this.maxSamples;
  }

  estimateMedian() {
    const samples = this.samples.filter(
      (sample): sample is number => sample !== undefined,
    );
    samples.sort((left, right) => left - right);
    if (samples.length) return samples[Math.floor(samples.length / 2)];
    return this.defaultEstimate;
  }

  estimateMean() {
    const smp = this.samples.filter((x): x is number => x !== undefined);
    smp.sort();
    if (smp.length) return smp.reduce((x, y) => x + y, 0) / smp.length;
    return this.defaultEstimate;
  }
}
