import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import React, {
  act,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot, type Root } from 'react-dom/client';
import useLatestRef from '../useLatestRef';

// Run the actual component definition while replacing only the imperative editor.
// This isolates callback ownership from autocomplete, backend and paid generation.
function loadActualEditor() {
  const filename = path.resolve(__dirname, '../PromptEditTextArea.tsx');
  const text = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(
    filename,
    text,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
  const statement = source.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === 'EmulatedEditTextArea',
      ),
  );
  if (!statement) throw new Error('The production editor component is missing');
  const compiled = ts.transpileModule(statement.getText(source), {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const instances: Array<{
    onUpdated: (value: string) => void;
    curText: string;
  }> = [];
  class EditorDouble {
    curText = '';

    onUpdated: (value: string) => void;

    constructor(
      _container: unknown,
      _editor: unknown,
      _clipboard: unknown,
      _highlight: unknown,
      onUpdated: (value: string) => void,
    ) {
      this.onUpdated = onUpdated;
      instances.push(this);
    }

    updateCurText(value: string) {
      this.curText = value;
    }

    updateDOM() {
      return this.curText;
    }

    handleBeforeInput() {
      this.onUpdated('typed');
    }

    handleKeyDown() {
      return this.curText;
    }

    handleCompositionUpdate() {
      return this.curText;
    }

    handlePaste() {
      return this.curText;
    }

    handleMouseDown() {
      return this.curText;
    }

    handleWindowMouseDown() {
      return this.curText;
    }
  }
  const bindings = {
    exports: {},
    React,
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useLatestRef,
    observer: <T,>(component: T) => component,
    CursorMemorizeEditor: EditorDouble,
    isMacPlatform: () => false,
    window,
    document,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    promptSegmentAt: () => '',
    mutex: {
      runExclusive: async (callback: () => Promise<void>) => callback(),
    },
    require: (id: string) => {
      if (id === 'react/jsx-runtime') return jsxRuntime;
      throw new Error(`Unexpected dependency in editor fixture: ${id}`);
    },
  };
  const Component = new vm.Script(
    `${compiled}\nEmulatedEditTextArea;`,
  ).runInNewContext(bindings) as React.ComponentType<any>;
  return { Component, instances };
}

describe('imperative prompt editor lifetime', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  const props = () => ({
    value: 'initial',
    disabled: false,
    highlight: (text: string) => text,
    onUpdated: jest.fn(),
    history: [],
    redo: [],
    onUpArrow: jest.fn(),
    onDownArrow: jest.fn(),
    onEnter: jest.fn(),
    onEsc: jest.fn(),
    onFocus: jest.fn(),
    onBlur: jest.fn(),
    closeAutoComplete: jest.fn(),
  });

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container.remove();
  });

  test('rerender uses the latest callback without resetting the editor', () => {
    const { Component, instances } = loadActualEditor();
    const initial = props();
    act(() => root?.render(<Component {...initial} />));
    const updated = jest.fn();
    act(() => root?.render(<Component {...initial} onUpdated={updated} />));
    const editor = container.querySelector('[contenteditable]')!;
    act(() => {
      editor.dispatchEvent(new Event('beforeinput', { bubbles: true }));
    });
    expect(updated).toHaveBeenCalledWith('typed');
    expect(initial.onUpdated).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
  });

  test('unmount removes handlers from the detached node after React clears the ref', () => {
    const { Component } = loadActualEditor();
    const initial = props();
    act(() => root?.render(<Component {...initial} />));
    const editor = container.querySelector('[contenteditable]')!;
    act(() => root?.unmount());
    root = undefined;
    act(() => {
      editor.dispatchEvent(new Event('beforeinput', { bubbles: true }));
    });
    expect(initial.onUpdated).not.toHaveBeenCalled();
  });

  test('focus and blur are forwarded to the current owner', () => {
    const { Component } = loadActualEditor();
    const initial = props();
    act(() => root?.render(<Component {...initial} />));
    const editor = container.querySelector('[contenteditable]')!;
    act(() => {
      editor.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    act(() => {
      editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(initial.onFocus).toHaveBeenCalledTimes(1);
    expect(initial.onBlur).toHaveBeenCalledTimes(1);
  });
});
