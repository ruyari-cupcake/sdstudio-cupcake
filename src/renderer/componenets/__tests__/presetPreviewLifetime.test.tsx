import path from 'path';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import { observable, runInAction } from 'mobx';
import loadComponentFixture from '../testSupport/componentFixture';
import {
  deferred,
  flushMicrotasks,
} from '../../models/testSupport/completionMethodHarness';

const source = path.resolve(__dirname, '../CharacterPresetCards.tsx');
function fixture() {
  const events = new EventTarget();
  const reads: Array<ReturnType<typeof deferred<string>>> = [];
  const fetchImageSmall = jest.fn(() => {
    const read = deferred<string>();
    reads.push(read);
    return read.promise;
  });
  const addEventListener = jest.fn(events.addEventListener.bind(events));
  const removeEventListener = jest.fn(events.removeEventListener.bind(events));
  const Preview = loadComponentFixture<Record<string, unknown>>(
    source,
    'VibeImage',
    {
      React,
      useEffect,
      useState,
      imageService: { fetchImageSmall, addEventListener, removeEventListener },
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClick = jest.fn();
  const render = (imagePath: string, interactive = false) =>
    act(() =>
      root.render(
        <Preview
          path={imagePath}
          className="preview"
          onClick={interactive ? onClick : undefined}
        />,
      ),
    );
  const settle = async (index: number, value: string) => {
    await act(async () => {
      reads[index].resolve(value);
      await flushMicrotasks();
    });
  };
  return {
    container,
    reads,
    render,
    settle,
    onClick,
    fetchImageSmall,
    removeEventListener,
    invalidate: (imagePath: string) =>
      act(() =>
        events.dispatchEvent(
          new CustomEvent('image-cache-invalidated', {
            detail: { path: imagePath },
          }),
        ),
      ),
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

test('preset preview belongs to the current image path', async () => {
  const f = fixture();
  try {
    f.render('old.png');
    f.render('current.png');
    await f.settle(1, 'data:image/png;base64,current');
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,current',
    );
    await f.settle(0, 'data:image/png;base64,old');
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,current',
    );
  } finally {
    f.dispose();
  }
  expect(f.removeEventListener).toHaveBeenCalledTimes(2);
});

test('newer invalidation read owns the current path preview', async () => {
  const f = fixture();
  try {
    f.render('same.png');
    f.invalidate('other.png');
    expect(f.fetchImageSmall).toHaveBeenCalledTimes(1);
    f.invalidate('same.png');
    await f.settle(1, 'data:image/png;base64,newer');
    await f.settle(0, 'data:image/png;base64,older');
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,newer',
    );
  } finally {
    f.dispose();
  }
});

test('interactive preset previews expose one named native button', async () => {
  const f = fixture();
  try {
    f.render('image.png', true);
    await f.settle(0, 'data:image/png;base64,image');
    const buttons = f.container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-label')).toBeTruthy();
    act(() => buttons[0].click());
    expect(f.onClick).toHaveBeenCalledTimes(1);
    expect(f.container.querySelector('img')?.hasAttribute('alt')).toBe(true);
  } finally {
    f.dispose();
  }
});

test('global preview observes a replaced representative image within the same entry', async () => {
  const entry = observable({
    name: 'sample',
    preset: {
      representativeImage: 'old.png',
      characterReferences: [],
      vibes: [],
    },
  });
  const fetchImageData = jest.fn(
    async (file: string) => `data:image/png;base64,${file}`,
  );
  const Preview = loadComponentFixture<Record<string, unknown>>(
    source,
    'GlobalCardImage',
    {
      React,
      useEffect,
      useState,
      observer,
      globalCharacterPresetService: { fetchImageData },
      FaUserAlt: 'span',
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<Preview entry={entry} className="preview" />);
      await flushMicrotasks();
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,old.png',
    );
    await act(async () => {
      runInAction(() => {
        entry.preset.representativeImage = 'current.png';
      });
      await flushMicrotasks();
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,current.png',
    );
    expect(fetchImageData).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
