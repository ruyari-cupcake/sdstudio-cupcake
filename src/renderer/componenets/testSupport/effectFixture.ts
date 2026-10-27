import fs from 'fs';
import vm from 'vm';
import ts from 'typescript';

/** Load an actual effect body to control its external IO and cleanup boundary. */
export default function loadEffectFixture(
  filename: string,
  uniqueMarker: string,
  bindings: Record<string, unknown>,
): () => (() => void) | undefined {
  const sourceText = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments[0] &&
      ts.isArrowFunction(node.arguments[0]) &&
      node.arguments[0].getText(source).includes(uniqueMarker)
    ) {
      matches.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (matches.length !== 1)
    throw new Error(`Expected one production effect, found ${matches.length}`);
  const compiled = ts.transpileModule(
    `const effect = ${matches[0].getText(source)}; effect;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
      fileName: filename,
    },
  ).outputText;
  return new vm.Script(compiled, { filename }).runInNewContext({ ...bindings });
}
