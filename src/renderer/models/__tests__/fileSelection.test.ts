/** @jest-environment jsdom */
import { getFirstFile } from '../fileSelection';

beforeEach(() => {
  jest
    .spyOn(HTMLInputElement.prototype, 'click')
    .mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

function activePicker() {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input)
    throw new Error(
      'The file picker owner should remain mounted until its actual event',
    );
  return input;
}

test('actual picker cancellation resolves undefined and releases both event handlers and the DOM owner', async () => {
  const selected = getFirstFile();
  const input = activePicker();
  const removed = jest.spyOn(input, 'removeEventListener');
  input.dispatchEvent(new Event('cancel'));
  await expect(selected).resolves.toBeUndefined();
  expect(removed.mock.calls.map((call) => call[0]).sort()).toEqual([
    'cancel',
    'change',
  ]);
  expect(input.isConnected).toBe(false);
});

test('actual selection returns the chosen File and closes the same picker owner', async () => {
  const selected = getFirstFile();
  const input = activePicker();
  const file = new File(['backup'], 'project.tar');
  const removed = jest.spyOn(input, 'removeEventListener');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
  await expect(selected).resolves.toBe(file);
  expect(removed).toHaveBeenCalledWith('change', expect.any(Function));
  expect(removed).toHaveBeenCalledWith('cancel', expect.any(Function));
  expect(input.isConnected).toBe(false);
});

test('an empty change event is cancellation without an error or a timeout', async () => {
  const selected = getFirstFile();
  const input = activePicker();
  Object.defineProperty(input, 'files', { configurable: true, value: [] });
  input.dispatchEvent(new Event('change'));
  await expect(selected).resolves.toBeUndefined();
  expect(input.isConnected).toBe(false);
});

test('a synchronous picker-open failure rejects after releasing the DOM owner', async () => {
  jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {
    throw new Error('picker unavailable');
  });
  await expect(getFirstFile()).rejects.toThrow('picker unavailable');
  expect(document.querySelector('input[type="file"]')).toBeNull();
});
