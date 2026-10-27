import path from 'path';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import loadComponentFixture from '../testSupport/componentFixture';

test('late preview responses cannot replace the newly selected image', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let finishFirst!: (value: string) => void;
  let finishSecond!: (value: string) => void;
  const first = new Promise<string>((resolve) => {
    finishFirst = resolve;
  });
  const second = new Promise<string>((resolve) => {
    finishSecond = resolve;
  });
  const fetchImageSmall = jest
    .fn()
    .mockReturnValueOnce(first)
    .mockReturnValueOnce(second);
  const Preview = loadComponentFixture<{
    path: string;
    cellSize: number;
    imageSize: number;
    style: React.CSSProperties;
  }>(path.resolve(__dirname, '../ResultViewer.tsx'), 'CellPreview', {
    useEffect,
    useState,
    imageService: { fetchImageSmall },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <Preview path="first.png" cellSize={100} imageSize={100} style={{}} />,
      ),
    );
    act(() =>
      root.render(
        <Preview path="second.png" cellSize={100} imageSize={100} style={{}} />,
      ),
    );
    await act(async () => {
      finishSecond('data:image/png;base64,NEW');
      await second;
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,NEW',
    );
    await act(async () => {
      finishFirst('data:image/png;base64,OLD');
      await first;
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,NEW',
    );
    expect(fetchImageSmall.mock.calls).toEqual([
      ['first.png', 100],
      ['second.png', 100],
    ]);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
