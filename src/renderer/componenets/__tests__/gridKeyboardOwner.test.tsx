import fs from 'fs';
import path from 'path';
import { Script } from 'vm';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import useLatestRef from '../useLatestRef';

type State = {
  activePaths: string[];
  paths: string[];
  scene: { name: string; type: string };
  selectedTab: number;
  curSession: { name: string };
  selectMode: boolean;
  sceneNav?: { go: (delta: number) => void };
  focusedImageIndex: number | null;
  selectedImageIndex?: number;
  activeGalleryRef: { current: null };
};
function loadOwner(bindings: Record<string, unknown>): React.FC<State> {
  const filename = path.resolve(__dirname, '../ResultViewer.tsx');
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const effects: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.getText(source).includes("'image-toggle-favorite'")
    )
      effects.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (effects.length !== 1)
    throw new Error('Expected the one production grid shortcut owner');
  const body = `(function bind(bindings) {
    const { useEffect, useLatestRef, window, document, toggleImageMain, gallaryRef, gallaryRef2,
      selectedImages, forceUpdate, setSelectMode, setFocusedImageIndex,
      setSelectedImageIndex, setSelectedTab } = bindings;
    return function Owner(props) {
      const { activePaths, paths, scene, selectedTab, curSession, selectMode, sceneNav,
        focusedImageIndex, selectedImageIndex, activeGalleryRef } = props;
      const gridKeyboardState = useLatestRef(props);
      ${effects[0].getText(source)};
      return null;
    };
  })`;
  const js = ts.transpileModule(body, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return new Script(js, { filename }).runInThisContext()({
    useEffect,
    useLatestRef,
    window,
    document,
    ...bindings,
  });
}
function fixture() {
  const toggleImageMain = jest.fn();
  const setFocusedImageIndex = jest.fn();
  const Owner = loadOwner({
    toggleImageMain,
    setFocusedImageIndex,
    gallaryRef: { current: null },
    gallaryRef2: { current: null },
    selectedImages: { current: new Set<string>() },
    forceUpdate: jest.fn(),
    setSelectMode: jest.fn(),
    setSelectedImageIndex: jest.fn(),
    setSelectedTab: jest.fn(),
  });
  const state: State = {
    activePaths: ['old.png'],
    paths: ['old.png'],
    scene: { name: 'scene', type: 'scene' },
    selectedTab: 0,
    curSession: { name: 'project' },
    selectMode: false,
    focusedImageIndex: 0,
    activeGalleryRef: { current: null },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return {
    toggleImageMain,
    state,
    render: (next: Partial<State> = {}) =>
      act(() => root.render(<Owner {...state} {...next} />)),
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
const favorite = () =>
  window.dispatchEvent(
    new CustomEvent('shortcut-action', {
      detail: { action: 'image-toggle-favorite' },
    }),
  );
beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

test('image-list updates retain one listener and act on the latest committed path', () => {
  const add = jest.spyOn(window, 'addEventListener');
  const remove = jest.spyOn(window, 'removeEventListener');
  const f = fixture();
  try {
    f.render();
    f.render({ activePaths: ['new.png'], paths: ['new.png'] });
    act(favorite);
    expect(f.toggleImageMain).toHaveBeenLastCalledWith(
      f.state.curSession,
      f.state.scene,
      'new.png',
    );
    expect(
      add.mock.calls.filter(([event]) => event === 'shortcut-action'),
    ).toHaveLength(1);
  } finally {
    f.dispose();
  }
  expect(
    remove.mock.calls.filter(([event]) => event === 'shortcut-action'),
  ).toHaveLength(1);
  add.mockRestore();
  remove.mockRestore();
});

test('a list shrinking below its focused index does not crash favorite navigation', () => {
  const f = fixture();
  const errors: unknown[] = [];
  const recordError = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener('error', recordError);
  try {
    f.render({
      activePaths: ['remaining.png'],
      paths: ['remaining.png'],
      focusedImageIndex: 4,
    });
    act(favorite);
    expect(errors).toEqual([]);
    expect(f.toggleImageMain).toHaveBeenLastCalledWith(
      f.state.curSession,
      f.state.scene,
      'remaining.png',
    );
  } finally {
    f.dispose();
    window.removeEventListener('error', recordError);
  }
});
