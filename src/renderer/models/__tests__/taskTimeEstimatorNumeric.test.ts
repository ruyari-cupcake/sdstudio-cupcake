/** @jest-environment node */
import { TaskTimeEstimator } from '../TaskTimeEstimator';

test('median orders numeric durations and follows ring replacement', () => {
  const estimator = new TaskTimeEstimator(3, 7);
  expect(estimator.estimateMedian()).toBe(7);
  estimator.addSample(2);
  estimator.addSample(10);
  estimator.addSample(30);
  expect(estimator.estimateMedian()).toBe(10);
  estimator.addSample(100);
  expect(estimator.estimateMedian()).toBe(30);
});

test('even sample counts keep the existing upper median policy', () => {
  const estimator = new TaskTimeEstimator(4, 7);
  [2, 10, 30, 100].forEach((time) => estimator.addSample(time));
  expect(estimator.estimateMedian()).toBe(30);
});
