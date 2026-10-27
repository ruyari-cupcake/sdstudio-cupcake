import fs from 'fs';
import path from 'path';
import { Script } from 'vm';
import ts from 'typescript';
import { isSceneEditorFocusTarget } from '../../models/sceneEditorFocus';

const filename = path.resolve(__dirname, '../SceneEditor.tsx');
const source = ts.createSourceFile(
  filename,
  fs.readFileSync(filename, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let expression: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (
    ts.isJsxAttribute(node) &&
    node.name.getText(source) === 'onBlurCapture' &&
    node.initializer &&
    ts.isJsxExpression(node.initializer)
  ) {
    if (expression) throw new Error('Ambiguous scene focus owner');
    expression = node.initializer.expression;
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!expression) throw new Error('Missing scene focus blur callback');
const js = ts.transpileModule(
  `(function bind(rootRef,setEditing,isEditableTarget,window,document,Element) { const isMobile = true; return (${expression.getText(source)}); })`,
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  },
).outputText;
const bind = new Script(js, { filename }).runInThisContext() as (
  root: { current: HTMLElement },
  setEditing: (active: boolean) => void,
  isEditableTarget: typeof isSceneEditorFocusTarget,
  browserWindow: Window,
  browserDocument: Document,
  elementType: typeof Element,
) => (event: { relatedTarget: Element | null }) => void;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test.each([true, false])(
  'blur commits the next editor ownership immediately (inside=%s)',
  (inside) => {
    const root = document.createElement('div');
    const next = document.createElement('textarea');
    if (inside) root.appendChild(next);
    const setEditing = jest.fn();
    const blur = bind(
      { current: root },
      setEditing,
      isSceneEditorFocusTarget,
      window,
      document,
      Element,
    );
    blur({ relatedTarget: next });
    expect(setEditing).toHaveBeenCalledWith(inside);
    expect(jest.getTimerCount()).toBe(0);
  },
);
