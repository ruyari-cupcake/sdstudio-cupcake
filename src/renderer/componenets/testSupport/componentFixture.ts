import fs from 'fs';
import vm from 'vm';
import ts from 'typescript';
import * as jsxRuntime from 'react/jsx-runtime';
import type { ComponentType } from 'react';

/** Exercise the actual component definition without starting native app services. */
export default function loadComponentFixture<Props>(
  filename: string,
  componentName: string,
  bindings: Record<string, unknown>,
): ComponentType<Props> {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(componentName)) {
    throw new Error('Invalid fixture component identifier');
  }
  const sourceText = fs.readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(
    filename,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const definition = source.statements.find((statement) => {
    if (ts.isFunctionDeclaration(statement))
      return statement.name?.text === componentName;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.some(
        (declaration) =>
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === componentName,
      );
    }
    return false;
  });
  if (!definition)
    throw new Error(`Missing component ${componentName} in ${filename}`);
  const compiled = ts.transpileModule(definition.getText(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;
  const script = new vm.Script(
    `${compiled}\n(typeof ${componentName} === 'undefined' ? exports.${componentName} : ${componentName});`,
    { filename },
  );
  return script.runInNewContext({
    exports: {},
    require(id: string) {
      if (id === 'react/jsx-runtime') return jsxRuntime;
      throw new Error(`Unexpected component fixture dependency: ${id}`);
    },
    ...bindings,
  }) as ComponentType<Props>;
}
