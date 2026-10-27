import path from 'path';
import loadEffectFixture from '../testSupport/effectFixture';
import { flushMicrotasks } from '../../models/testSupport/completionMethodHarness';

const source = path.resolve(__dirname, '../ExternalImageView.tsx');
const metadata = (prompt: string) => ({ prompt, uc: '', characterPrompts: [] });
function loadMetadataEffect(
  image: string,
  pending: Promise<unknown>,
  setters: Record<string, unknown>,
) {
  return loadEffectFixture(source, 'extractPromptDataFromBase64', {
    image,
    extractPromptDataFromBase64: () => pending,
    setOptions: jest.fn(),
    setMetadataLoading: jest.fn(),
    setMetadataError: jest.fn(),
    ...setters,
  });
}

test('late metadata from an abandoned image cannot replace the current image settings', async () => {
  let finishOld!: (value: unknown) => void;
  let finishCurrent!: (value: unknown) => void;
  const old = new Promise<unknown>((resolve) => {
    finishOld = resolve;
  });
  const current = new Promise<unknown>((resolve) => {
    finishCurrent = resolve;
  });
  const setJob = jest.fn();
  const disposeOld = loadMetadataEffect('old-image', old, { setJob })();
  disposeOld?.();
  const disposeCurrent = loadMetadataEffect('current-image', current, {
    setJob,
  })();
  finishCurrent(metadata('current prompt'));
  await current;
  await flushMicrotasks();
  expect(setJob).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: 'current prompt' }),
  );
  finishOld(metadata('old prompt'));
  await old;
  await flushMicrotasks();
  expect(setJob).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: 'current prompt' }),
  );
  disposeCurrent?.();
});

test('a new image immediately clears the previously importable job', () => {
  const pending = new Promise<unknown>(() => {});
  const setJob = jest.fn();
  const cleanup = loadMetadataEffect('next-image', pending, { setJob })();
  expect(setJob).toHaveBeenCalledWith(undefined);
  cleanup?.();
});

test('missing metadata reaches a visible terminal result instead of an endless loading state', async () => {
  const pending = Promise.resolve(undefined);
  const setMetadataLoading = jest.fn();
  const setMetadataError = jest.fn();
  const cleanup = loadMetadataEffect('metadata-free-image', pending, {
    setJob: jest.fn(),
    setMetadataLoading,
    setMetadataError,
  })();
  await pending;
  await flushMicrotasks();
  expect(setMetadataLoading).toHaveBeenLastCalledWith(false);
  expect(setMetadataError).toHaveBeenLastCalledWith(
    '적용할 생성 설정이 없습니다.',
  );
  cleanup?.();
});
