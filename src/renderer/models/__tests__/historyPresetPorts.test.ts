import { Scene, Session } from '../types';

jest.mock('..', () => {
  throw new Error(
    'Preset and history services must not construct the application',
  );
});

describe('preset and history service ports', () => {
  it.each([
    ['GlobalCharacterPresetService', '../GlobalCharacterPresetService'],
    ['ImageHistoryService', '../ImageHistoryService'],
  ])(
    'loads %s independently of application construction',
    (className, modulePath) => {
      const loaded = jest.requireActual(modulePath);
      expect(typeof loaded[className]).toBe('function');
    },
  );

  it('installs history listeners in order before loading and uses the supplied favorite capability', async () => {
    jest.useFakeTimers();
    try {
      const { ImageHistoryService } = jest.requireActual<
        typeof import('../ImageHistoryService')
      >('../ImageHistoryService');
      const events = new EventTarget();
      const imageSource = {
        addEventListener: jest.fn(events.addEventListener.bind(events)),
        images: {},
        inpaints: {},
      };
      const storage = {
        existFile: jest.fn(async () => false),
        readFile: jest.fn(async () => ''),
        writeFile: jest.fn(async () => undefined),
      };
      const session = new Session();
      session.name = 'fixture';
      const scene = new Scene();
      scene.name = 'scene';
      session.addScene(scene);
      const sessionSource = {
        list: jest.fn(() => ['fixture']),
        get: jest.fn(async () => session),
      };
      const toggleFavorite = jest.fn();
      const history = new ImageHistoryService(
        storage,
        imageSource,
        sessionSource,
        toggleFavorite,
      );

      expect(
        imageSource.addEventListener.mock.calls.map(([name]) => name),
      ).toEqual(['image-added', 'updated']);
      expect(storage.existFile).not.toHaveBeenCalled();
      expect(storage.readFile).not.toHaveBeenCalled();
      events.dispatchEvent(
        new CustomEvent('image-added', {
          detail: {
            session,
            sceneType: 'scene',
            sceneName: scene.name,
            filename: 'one.png',
            path: 'outs/fixture/scene/one.png',
          },
        }),
      );
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toEqual(
        expect.objectContaining({
          sessionName: 'fixture',
          sceneType: 'scene',
          sceneName: 'scene',
          filename: 'one.png',
        }),
      );

      await history.toggleFavorite(history.entries[0]);
      expect(toggleFavorite).toHaveBeenCalledTimes(1);
      expect(toggleFavorite).toHaveBeenCalledWith(session, scene, 'one.png');
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });
});
