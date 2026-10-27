import path from 'path';
import React, { act, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import { observable, runInAction } from 'mobx';
import loadComponentFixture from '../testSupport/componentFixture';

test('a character card follows a replaced first reference path without a length change', () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const preset = observable({
    name: 'Example',
    representativeImage: '',
    characterReferences: [{ path: 'first.png' }],
    vibes: [],
  });
  const Card = loadComponentFixture<{
    preset: typeof preset;
    className: string;
  }>(path.resolve(__dirname, '../CharacterPresetCards.tsx'), 'CardImage', {
    observer,
    useMemo,
    appState: { curSession: { name: 'project' } },
    imageService: {
      getReferenceImagePath: (_session: unknown, token: string) => token,
      getVibeImagePath: (_session: unknown, token: string) => token,
    },
    VibeImage: ({ path: imagePath }: { path: string }) => (
      <img alt="fixture" data-image-path={imagePath} />
    ),
    FaUserAlt: 'span',
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<Card preset={preset} className="preview" />));
    expect(
      container.querySelector('img')?.getAttribute('data-image-path'),
    ).toBe('first.png');
    act(() =>
      runInAction(() => {
        preset.characterReferences[0].path = 'replacement.png';
      }),
    );
    expect(
      container.querySelector('img')?.getAttribute('data-image-path'),
    ).toBe('replacement.png');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
