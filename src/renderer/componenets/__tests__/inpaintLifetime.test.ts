import path from 'path';
import loadEffectFixture from '../testSupport/effectFixture';
import {
  deferred,
  flushMicrotasks,
} from '../../models/testSupport/completionMethodHarness';

const source = path.resolve(__dirname, '../InPaintEditor.tsx');

function imageFixture(
  imageResult: Promise<string | null>,
  maskResult?: Promise<string | null>,
) {
  const events = new EventTarget();
  const disposeReaction = jest.fn();
  const fetchVibeImage = jest.fn((_session: unknown, token: string) =>
    token === 'mask.png' ? maskResult : imageResult,
  );
  const setters = {
    setImage: jest.fn(),
    setMask: jest.fn(),
    setFocusTool: jest.fn(),
    setBrushing: jest.fn(),
  };
  const imageService = {
    fetchVibeImage,
    getVibeImagePath: (_session: unknown, token: string) =>
      `project/vibes/${token}`,
    addEventListener: jest.fn(events.addEventListener.bind(events)),
    removeEventListener: jest.fn(events.removeEventListener.bind(events)),
  };
  const effect = loadEffectFixture(source, 'async function loadImage()', {
    ...setters,
    editingScene: {
      preset: { image: 'source.png', mask: maskResult ? 'mask.png' : '' },
    },
    curSession: { name: 'project' },
    def: { hasMask: !!maskResult },
    isMirror: false,
    isMobile: false,
    imageService,
    reaction: () => disposeReaction,
    dataUriToBase64: (value: string) => value,
    appState: { pushMessage: jest.fn() },
    refreshMirrorCanvas: jest.fn(),
  });
  return {
    effect,
    events,
    fetchVibeImage,
    imageService,
    disposeReaction,
    ...setters,
  };
}

test('an abandoned inpaint image and mask cannot write into its replacement view', async () => {
  const image = deferred<string | null>();
  const mask = deferred<string | null>();
  const fixture = imageFixture(image.promise, mask.promise);
  const cleanup = fixture.effect();
  fixture.setImage.mockClear();
  fixture.setMask.mockClear();
  cleanup?.();
  image.resolve('old image');
  mask.resolve('old mask');
  await flushMicrotasks();
  expect(fixture.setImage).not.toHaveBeenCalled();
  expect(fixture.setMask).not.toHaveBeenCalled();
  expect(fixture.disposeReaction).toHaveBeenCalled();
  expect(fixture.imageService.removeEventListener.mock.calls).toEqual(
    fixture.imageService.addEventListener.mock.calls,
  );
});

test('unrelated cache invalidation does not reread the inpaint image', async () => {
  const fixture = imageFixture(Promise.resolve('source image'));
  const cleanup = fixture.effect();
  await flushMicrotasks();
  expect(fixture.fetchVibeImage).toHaveBeenCalledTimes(1);
  fixture.events.dispatchEvent(
    new CustomEvent('image-cache-invalidated', {
      detail: { path: 'project/outs/another.png' },
    }),
  );
  await flushMicrotasks();
  expect(fixture.fetchVibeImage).toHaveBeenCalledTimes(1);
  fixture.events.dispatchEvent(
    new CustomEvent('image-cache-invalidated', {
      detail: { path: 'project/vibes/source.png' },
    }),
  );
  await flushMicrotasks();
  expect(fixture.fetchVibeImage).toHaveBeenCalledTimes(2);
  cleanup?.();
});

test('an abandoned dimension read cannot replace current canvas dimensions', async () => {
  const pending = deferred<{ width: number; height: number }>();
  const scene = { preset: {}, workflowType: 'SDInpaint' };
  const setWidth = jest.fn();
  const setHeight = jest.fn();
  const setLoadedDims = jest.fn();
  const effect = loadEffectFixture(source, 'getImageDimensions(image)', {
    image: 'old image',
    editingScene: scene,
    editingSceneRef: { current: scene },
    getImageDimensions: () => pending.promise,
    setWidth,
    setHeight,
    setLoadedDims,
    presetSupportsFocus: () => false,
    appState: { pushMessage: jest.fn() },
  });
  const cleanup = effect();
  setWidth.mockClear();
  setHeight.mockClear();
  setLoadedDims.mockClear();
  cleanup?.();
  pending.resolve({ width: 2048, height: 1024 });
  await flushMicrotasks();
  expect(setWidth).not.toHaveBeenCalled();
  expect(setHeight).not.toHaveBeenCalled();
  expect(setLoadedDims).not.toHaveBeenCalled();
});

test.each(['brush', 'focus', 'pan'])(
  'the %s tool tolerates a canvas that is not mounted yet',
  (pointerTarget) => {
    const effect = loadEffectFixture(source, 'startBrushing()', {
      pointerTarget,
      image: '',
      brushTool: { current: null },
    });
    expect(() => effect()).not.toThrow();
  },
);
