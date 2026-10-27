import path from 'path';
import React, { act, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import loadComponentFixture from '../testSupport/componentFixture';
import loadEffectFixture from '../testSupport/effectFixture';
import {
  deferred,
  flushMicrotasks,
} from '../../models/testSupport/completionMethodHarness';

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

type Reader = {
  result: string | null;
  error: Error | null;
  onload?: () => void;
  onloadend?: () => void;
  onerror?: () => void;
  onabort?: () => void;
  readAsDataURL: jest.Mock;
  abort: jest.Mock;
};

function uploadFixture() {
  const readers: Reader[] = [];
  const onFileSelect = jest.fn();
  function FileReaderFixture() {
    const reader: Reader = {
      result: null,
      error: null,
      readAsDataURL: jest.fn(),
      abort: jest.fn(),
    };
    readers.push(reader);
    return reader;
  }
  const View = loadComponentFixture<{ onFileSelect: typeof onFileSelect }>(
    path.resolve(__dirname, '../UtilComponents.tsx'),
    'FileUploadBase64',
    {
      React,
      useState,
      useRef,
      useEffect,
      FileReader: FileReaderFixture,
      ActionIcon: () => null,
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<View onFileSelect={onFileSelect} />));
  const input = container.querySelector('input')!;
  Object.defineProperty(input, 'files', {
    value: [new File(['png'], 'image.png')],
  });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  return {
    container,
    reader: readers[0],
    onFileSelect,
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

test('failed file reads show an error instead of splitting a null result', () => {
  const f = uploadFixture();
  try {
    f.reader.error = new Error('file unavailable');
    act(() => {
      f.reader.onerror?.();
      f.reader.onloadend?.();
    });
    expect(f.onFileSelect).not.toHaveBeenCalled();
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain(
      '실패',
    );
  } finally {
    f.dispose();
  }
});

test('a file read completed after unmount cannot submit an upload', () => {
  const f = uploadFixture();
  f.dispose();
  f.reader.result = 'data:image/png;base64,payload';
  act(() => {
    f.reader.onload?.();
    f.reader.onloadend?.();
  });
  expect(f.onFileSelect).not.toHaveBeenCalled();
});

test('leaving a tournament before game creation completes releases its UI ownership', async () => {
  const pending = deferred<Array<{ path: string; rank: number }>>();
  const scene: { game?: Array<{ path: string; rank: number }> } = {};
  const listFiles = jest.fn(async () => ['first.png']);
  const loadRoundInitial = jest.fn();
  const pushDialog = jest.fn();
  const pushMessage = jest.fn();
  const effect = loadEffectFixture(
    path.resolve(__dirname, '../Tournament.tsx'),
    'gameService.createGame(path)',
    {
      scene,
      path: 'images/old-scene',
      gameService: { createGame: () => pending.promise },
      backend: { listFiles },
      appState: { pushDialog, pushMessage },
      setPlayers: jest.fn(),
      setImages: jest.fn(),
      setFinalRank: jest.fn(),
      loadRoundInitial,
      isOutputImageFile: () => true,
    },
  );
  const cleanup = effect();
  if (typeof cleanup === 'function') cleanup();
  pending.resolve([{ path: 'first.png', rank: 0 }]);
  await flushMicrotasks();
  expect(scene.game).toBeUndefined();
  expect(listFiles).not.toHaveBeenCalled();
  expect(loadRoundInitial).not.toHaveBeenCalled();
  expect(pushDialog).not.toHaveBeenCalled();
  expect(pushMessage).not.toHaveBeenCalled();
});
