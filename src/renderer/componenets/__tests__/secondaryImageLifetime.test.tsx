import path from 'path';
import React, { act, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import loadComponentFixture from '../testSupport/componentFixture';
import loadEffectFixture from '../testSupport/effectFixture';
import activateButtonFromKeyboard from '../keyboardButton';

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

test.each(['VibeImage', 'SceneImage'] as const)(
  '%s rejects a late image from the previous selection and releases listeners',
  async (componentName) => {
    const first = deferred<string>();
    const second = deferred<string>();
    const read = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const imageEvents = new EventTarget();
    const gameEvents = new EventTarget();
    const imageService = {
      fetchImageSmall: read,
      addEventListener: jest.fn(imageEvents.addEventListener.bind(imageEvents)),
      removeEventListener: jest.fn(
        imageEvents.removeEventListener.bind(imageEvents),
      ),
    };
    const gameService = {
      addEventListener: jest.fn(gameEvents.addEventListener.bind(gameEvents)),
      removeEventListener: jest.fn(
        gameEvents.removeEventListener.bind(gameEvents),
      ),
    };
    const Preview = loadComponentFixture<Record<string, unknown>>(
      path.resolve(
        __dirname,
        componentName === 'VibeImage'
          ? '../VibeEditor.tsx'
          : '../SceneSelector.tsx',
      ),
      componentName,
      {
        React,
        useCallback,
        useEffect,
        useState,
        imageService,
        gameService,
        activateButtonFromKeyboard,
        console,
      },
    );
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const firstScene = { name: 'first' };
    const secondScene = { name: 'second' };
    const props = (selected: string, scene: { name: string }) =>
      componentName === 'VibeImage'
        ? { path: selected, className: '' }
        : { scene, getImage: read };
    try {
      act(() => root.render(<Preview {...props('first.png', firstScene)} />));
      act(() => root.render(<Preview {...props('second.png', secondScene)} />));
      await act(async () => {
        second.resolve('data:image/png;base64,NEW');
        await second.promise;
      });
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,NEW',
      );
      await act(async () => {
        first.resolve('data:image/png;base64,OLD');
        await first.promise;
      });
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'data:image/png;base64,NEW',
      );
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
    expect(imageService.removeEventListener.mock.calls).toEqual(
      imageService.addEventListener.mock.calls,
    );
    expect(gameService.removeEventListener.mock.calls).toEqual(
      gameService.addEventListener.mock.calls,
    );
  },
);

test('tournament image reads stop updating and reading after their view is replaced', async () => {
  const first = deferred<string>();
  const fetchImage = jest
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue('second');
  const setImages = jest.fn();
  const effect = loadEffectFixture(
    path.resolve(__dirname, '../Tournament.tsx'),
    'imageService.fetchImage',
    {
      scene: { round: {}, game: [] },
      players: ['first.png', 'second.png'],
      curSession: { name: 'session' },
      imageService: { fetchImage, getOutputDir: () => 'outs/scene' },
      appState: { pushMessage: jest.fn() },
      setImages,
    },
  );
  const cleanup = effect();
  setImages.mockClear();
  cleanup?.();
  first.resolve('old');
  await first.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(setImages).not.toHaveBeenCalled();
  expect(fetchImage).toHaveBeenCalledTimes(1);
});
