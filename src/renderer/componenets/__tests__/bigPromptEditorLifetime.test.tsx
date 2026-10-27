import fs from 'fs';
import path from 'path';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import loadComponentFixture from '../testSupport/componentFixture';

const leaf = path.resolve(__dirname, '../BigPromptEditor.tsx');
const source = fs.existsSync(leaf)
  ? leaf
  : path.resolve(__dirname, '../SceneEditor.tsx');
const deferred = <T,>() => {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
};

function fixture(
  fetchImage: (filename: string) => Promise<string | undefined>,
) {
  const events = new EventTarget();
  const addEventListener = jest.fn(events.addEventListener.bind(events));
  const removeEventListener = jest.fn(events.removeEventListener.bind(events));
  const callbacks: Array<(filename: string) => void> = [];
  const queuePrompt = jest.fn(
    (_prompt: string, callback: (filename: string) => void) =>
      callbacks.push(callback),
  );
  const Editor = loadComponentFixture<Record<string, unknown>>(
    source,
    'BigPromptEditor',
    {
      observer,
      useEffect,
      useState,
      setTimeout,
      clearTimeout,
      imageService: { fetchImage },
      taskQueueService: {
        addEventListener,
        removeEventListener,
        isRunning: () => false,
      },
      isMobile: false,
      KBD_CHIP_RESERVE_PX: 0,
      FloatView: ({ children }: React.PropsWithChildren) => children,
      UnionPreSetEditor: () => null,
      TaskProgressBar: () => null,
      SceneSeedInput: ({ disabled }: { disabled?: boolean }) => (
        <input data-seed="" disabled={disabled} />
      ),
      PromptEditTextArea: ({
        value,
        disabled,
      }: {
        value: string;
        disabled?: boolean;
      }) => <textarea value={value} readOnly disabled={disabled} />,
      Tooltip: ({
        children,
        content,
      }: React.PropsWithChildren<{ content: string }>) => (
        <span data-tooltip={content}>{children}</span>
      ),
      FaStar: 'span',
      FaPlay: 'span',
      FaStop: 'span',
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (prompt = 'middle') =>
    act(() =>
      root.render(
        <Editor
          general
          simplified
          presetEditor={null}
          getMiddlePrompt={() => prompt}
          setMiddlePrompt={() => {}}
          getCharacterMiddlePrompt={() => ''}
          setCharacterMiddlePrompt={() => {}}
          queuePrompt={queuePrompt}
          initialImagePath="old.png"
          getSceneUC={() => ''}
          setSceneUC={() => {}}
          sceneSeed={0}
          onSceneSeedChange={() => {}}
        />,
      ),
    );
  return {
    container,
    render,
    callbacks,
    addEventListener,
    removeEventListener,
    generate: () =>
      act(() =>
        (
          container.querySelector(
            '[data-tooltip="생성"] button',
          ) as HTMLButtonElement
        ).click(),
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

test('committed prompt and seed inputs are ready without waiting for a timer', () => {
  const f = fixture(() => new Promise(() => {}));
  try {
    f.render();
    expect(f.container.querySelectorAll('textarea')).toHaveLength(2);
    for (const input of f.container.querySelectorAll('textarea, input')) {
      expect((input as HTMLInputElement).disabled).toBe(false);
    }
  } finally {
    f.dispose();
  }
});

test('a late preview cannot replace the most recently generated image', async () => {
  const old = deferred<string>();
  const current = deferred<string>();
  const f = fixture((filename) =>
    filename === 'old.png' ? old.promise : current.promise,
  );
  try {
    f.render();
    f.generate();
    act(() => f.callbacks[0]('new.png'));
    await act(async () => {
      current.resolve('data:image/png;base64,current');
      await current.promise;
    });
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,current',
    );
    await act(async () => {
      old.resolve('data:image/png;base64,old');
      await old.promise;
    });
    expect(f.container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,current',
    );
  } finally {
    f.dispose();
  }
});

test('editing a prompt retains one task-progress subscription until unmount', () => {
  const f = fixture(() => new Promise(() => {}));
  try {
    f.render();
    f.render('changed prompt');
    expect(f.addEventListener).toHaveBeenCalledTimes(3);
    expect(f.removeEventListener).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
  expect(f.removeEventListener).toHaveBeenCalledTimes(3);
});
