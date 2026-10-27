import nodePath from 'path';
import React, { act, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import loadComponentFixture from '../testSupport/componentFixture';

class ImageItem {
  constructor(
    public path: string,
    public info = 1,
    public strength = 0.6,
  ) {}

  static fromJSON(value: ImageItem) {
    return new ImageItem(value.path, value.info, value.strength);
  }

  toJSON() {
    return { path: this.path, info: this.info, strength: this.strength };
  }
}

function fixture() {
  const Editor = loadComponentFixture<Record<string, unknown>>(
    nodePath.resolve(__dirname, '../CharacterPresetInnerEditor.tsx'),
    'CharacterPresetInnerEditor',
    {
      React,
      useEffect,
      useMemo,
      useRef,
      useState,
      observer,
      VibeItem: ImageItem,
      ReferenceItem: ImageItem,
      CharacterPreset: function CharacterPresetFixture() {},
      useBackLayer: () => {},
      useGuardedClose: (_guard: unknown, close: unknown) => close,
      appState: { pushMessage: jest.fn() },
      getRefDefaults: () => ({}),
      FileUploadBase64: () => null,
      VibeImage: () => null,
      PromptEditTextArea: () => null,
      EditableSliderValue: ({
        value,
        onChange,
      }: {
        value: number;
        onChange: (next: number) => void;
      }) => (
        <button
          type="button"
          data-change=""
          onClick={() => onChange(value + 0.1)}
        >
          change
        </button>
      ),
      Tooltip: ({
        children,
        content,
      }: React.PropsWithChildren<{ content: string }>) => (
        <span data-tooltip={content}>{children}</span>
      ),
      FaArrowLeft: 'span',
      FaCheck: 'span',
      FaToggleOff: 'span',
      FaToggleOn: 'span',
      FaTrash: 'span',
      FaUserAlt: 'span',
    },
  );
  const preset = {
    name: 'sample',
    characterPrompt: '',
    characterUC: '',
    backgroundPrompt: '',
    vibes: [new ImageItem('shared.png'), new ImageItem('shared.png')],
    characterReferences: [],
    representativeImage: '',
    filenamePrefix: '',
    filenameSuffix: '',
  };
  const imageBackend = {
    vibePath: (token: string) => token,
    referencePath: (token: string) => token,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <Editor
        preset={preset}
        imageBackend={imageBackend}
        onSave={() => {}}
        onCancel={() => {}}
        isNew={false}
      />,
    ),
  );
  return {
    container,
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

test('deleting an earlier duplicate image keeps the surviving row and its focus', () => {
  const f = fixture();
  try {
    const second = f.container.querySelectorAll<HTMLInputElement>(
      'input[type="range"]',
    )[2];
    second.focus();
    act(() =>
      (
        f.container.querySelector(
          '[data-tooltip="바이브 삭제"] button',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(f.container.querySelector('input[type="range"]')).toBe(second);
    expect(document.activeElement).toBe(second);
  } finally {
    f.dispose();
  }
});

test('editing a cloned image item preserves the row control and keyboard focus', () => {
  const f = fixture();
  try {
    const second = f.container.querySelectorAll<HTMLInputElement>(
      'input[type="range"]',
    )[2];
    second.focus();
    act(() =>
      (
        f.container.querySelectorAll('[data-change]')[2] as HTMLButtonElement
      ).click(),
    );
    expect(f.container.querySelectorAll('input[type="range"]')[2]).toBe(second);
    expect(document.activeElement).toBe(second);
  } finally {
    f.dispose();
  }
});
