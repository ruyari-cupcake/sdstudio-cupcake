import fs from 'fs';
import path from 'path';
import vm from 'vm';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';

type Props = {
  curSession: object;
  type: string;
  isActive: boolean;
  selectedCount: number;
  addAllToQueue: () => void;
  addSelectedToQueue: () => void;
};
function loadShortcutOwner(): React.FC<Props> {
  const sourcePath = path.resolve(__dirname, '../SceneQueueControl.tsx');
  const source = ts.createSourceFile(
    sourcePath,
    fs.readFileSync(sourcePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const effects: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'useEffect' &&
      node.getText(source).includes("'queue-all-scenes'")
    )
      effects.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (effects.length !== 1)
    throw new Error('Expected exactly one queue-all shortcut owner');
  // Execute the production effect including its dependency array. React decides
  // when to replace its actual window listener on prop changes and unmount.
  const js = ts.transpileModule(
    `function ShortcutOwner({curSession,type,isActive,selectedCount,addAllToQueue,addSelectedToQueue}) { ${effects[0].getText(source)}; return null; }`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  return new vm.Script(`${js}\nShortcutOwner;`, {
    filename: sourcePath,
  }).runInNewContext({ useEffect, window }) as React.FC<Props>;
}
const Owner = loadShortcutOwner();
const dispatch = () =>
  window.dispatchEvent(
    new CustomEvent('shortcut-action', {
      detail: { action: 'queue-all-scenes' },
    }),
  );

function fixture() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props: Props = {
    curSession: {},
    type: 'scene',
    isActive: true,
    selectedCount: 0,
    addAllToQueue: jest.fn(),
    addSelectedToQueue: jest.fn(),
  };
  return {
    props,
    render: (patch: Partial<Props> = {}) =>
      act(() => root.render(<Owner {...props} {...patch} />)),
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

test('the shortcut uses the selection from the latest committed render', () => {
  const f = fixture();
  try {
    f.render();
    f.render({ selectedCount: 2 });
    act(dispatch);
    expect(f.props.addSelectedToQueue).toHaveBeenCalledTimes(1);
    expect(f.props.addAllToQueue).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

test('hidden scene tabs do not schedule paid generation from a global shortcut', () => {
  const f = fixture();
  try {
    f.render({ isActive: false });
    act(dispatch);
    expect(f.props.addSelectedToQueue).not.toHaveBeenCalled();
    expect(f.props.addAllToQueue).not.toHaveBeenCalled();
  } finally {
    f.dispose();
  }
});

test('changing tabs releases the old shortcut owner and unmount removes the active one', () => {
  const f = fixture();
  f.render();
  f.render({ isActive: false });
  act(dispatch);
  expect(f.props.addAllToQueue).not.toHaveBeenCalled();
  f.render({ isActive: true });
  act(dispatch);
  expect(f.props.addAllToQueue).toHaveBeenCalledTimes(1);
  f.dispose();
  act(dispatch);
  expect(f.props.addAllToQueue).toHaveBeenCalledTimes(1);
});
