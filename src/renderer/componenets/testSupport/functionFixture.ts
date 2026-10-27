import fs from 'fs';
import vm from 'vm';
import ts from 'typescript';

interface FunctionSelector {
  name?: string;
  property?: string;
  hook?: 'useEffect' | 'useLayoutEffect' | 'effect';
  contains?: string;
}

/** Load one real callback body without constructing the application service graph. */
export default function loadFunctionFixture(
  file: string,
  selector: FunctionSelector,
  bindings: Record<string, unknown>,
): (...args: any[]) => any {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    let candidate: ts.Node | undefined;
    if (
      selector.hook &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === selector.hook ||
        (selector.hook === 'effect' &&
          ['useEffect', 'useLayoutEffect'].includes(node.expression.text))) &&
      node.arguments[0] &&
      ts.isArrowFunction(node.arguments[0])
    ) {
      [candidate] = node.arguments;
    }
    if (
      selector.name &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === selector.name
    )
      candidate = node;
    if (
      selector.name &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === selector.name
    )
      candidate = node.initializer;
    if (
      selector.property &&
      ts.isPropertyAssignment(node) &&
      node.name.getText(source) === selector.property
    )
      candidate = node.initializer;
    if (
      candidate &&
      (!selector.contains ||
        candidate.getText(source).includes(selector.contains))
    )
      matches.push(candidate);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (matches.length !== 1)
    throw new Error(
      `Expected one production callback: ${JSON.stringify(selector)}, found ${matches.length}`,
    );
  // Module export modifiers do not belong to the extracted function expression.
  const expression = matches[0]
    .getText(source)
    .replace(/^export\s+(?:default\s+)?(?=(?:async\s+)?function\b)/, '');
  const compiled = ts.transpileModule(`const subject = (${expression});`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return vm.runInNewContext(`${compiled}\nsubject;`, { ...bindings });
}
