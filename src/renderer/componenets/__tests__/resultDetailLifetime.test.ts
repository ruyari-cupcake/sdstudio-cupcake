import path from 'path';
import { setImmediate as nextTurn } from 'timers/promises';
import loadEffectFixture from '../testSupport/effectFixture';

function fixture(paths: string[]) {
  let finishMetadata!: (value: unknown) => void;
  const metadata = new Promise((resolve) => {
    finishMetadata = resolve;
  });
  const extractPromptDataFromBase64 = jest.fn().mockReturnValue(metadata);
  const stateNames = [
    'setImage',
    'setImageLoadFailed',
    'setUpscaleInfo',
    'setMiddlePrompt',
    'setCharacterPrompts',
    'setSeed',
    'setScale',
    'setSampler',
    'setSteps',
    'setUc',
    'setFilename',
    'forceUpdate',
    'setSelectedIndex',
    'setPaths',
  ];
  const setters = Object.fromEntries(
    stateNames.map((name) => [name, jest.fn()]),
  );
  const events = () => ({
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  });
  const imageService = {
    ...events(),
    fetchImage: jest.fn().mockResolvedValue('data:image/png;base64,IMAGE'),
  };
  const onClose = jest.fn();
  const callbacksRef = { current: { getPaths: () => paths, onClose } };
  const effect = loadEffectFixture(
    path.resolve(__dirname, '../ResultViewer.tsx'),
    'const upscalePath = paths[selectedIndex];',
    {
      ...setters,
      paths,
      selectedIndex: 0,
      curSession: {},
      scene: {},
      imageService,
      extractPromptDataFromBase64,
      dataUriToBase64: (value: string) => value,
      getImageDimensions: jest
        .fn()
        .mockResolvedValue({ width: 1024, height: 1024 }),
      estimateNaiUpscaleCost: () => 10,
      filenameRef: { current: '' },
      window: events(),
      sessionService: events(),
      gameService: events(),
      console,
      onClose,
      getPaths: () => paths,
      callbacksRef,
    },
  );
  return {
    effect,
    setters,
    imageService,
    finishMetadata,
    extractPromptDataFromBase64,
    onClose,
  };
}

test('old image metadata cannot update the detail view after its owner changes', async () => {
  const f = fixture(['first.png']);
  const cleanup = f.effect();
  await nextTurn();
  expect(f.extractPromptDataFromBase64).toHaveBeenCalledTimes(1);
  cleanup?.();
  for (const setter of Object.values(f.setters)) setter.mockClear();
  f.finishMetadata({
    prompt: 'old prompt',
    characterPrompts: [],
    seed: 5,
    promptGuidance: 5,
    sampling: 'old sampler',
    steps: 28,
    uc: 'old negative prompt',
  });
  await nextTurn();
  expect(f.setters.setMiddlePrompt).not.toHaveBeenCalled();
  expect(f.setters.setFilename).not.toHaveBeenCalled();
});

test('an empty detail view closes without dereferencing a missing image', async () => {
  const f = fixture([]);
  expect(() => f.effect()).not.toThrow();
  await nextTurn();
  expect(f.onClose).toHaveBeenCalledTimes(1);
  expect(f.imageService.fetchImage).not.toHaveBeenCalled();
});
