import fs from 'fs';
import { runInThisContext } from 'vm';
import ts from 'typescript';

/** Exercise the real service methods without booting the native/MobX service graph. */
export function loadServiceMethods(
  file: string,
  className: string,
  methodNames: string[],
  bindings: Record<string, unknown>,
): any {
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const bindingNames = Object.keys(bindings);
  if (
    !identifier.test(className) ||
    bindingNames.some((name) => !identifier.test(name))
  ) {
    throw new Error('Invalid service fixture identifier');
  }
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = source.statements.find(
    (node) => ts.isClassDeclaration(node) && node.name?.text === className,
  ) as ts.ClassDeclaration | undefined;
  if (!owner) throw new Error(`Missing production class ${className}`);
  const methods = owner.members.filter(
    (node) =>
      ts.isMethodDeclaration(node) &&
      node.name &&
      methodNames.includes(node.name.getText(source)),
  );
  if (!methods.some((node) => node.name?.getText(source) === methodNames[0])) {
    throw new Error(`Missing production method ${methodNames[0]}`);
  }
  const compiled = ts.transpileModule(
    `class ${className} {\n${methods
      .map((node) => node.getText(source))
      .join('\n')}\n}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  // Same-realm execution preserves Error/Array identity. Keep the production class
  // name so actual class-qualified static helper references retain their owner.
  const factory = runInThisContext(
    `(function(${bindingNames.join(',')}) {\n${compiled}\nreturn ${
      className
    };\n})`,
    { filename: file },
  );
  return factory(...Object.values(bindings));
}

export function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

export async function flushMicrotasks() {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}
