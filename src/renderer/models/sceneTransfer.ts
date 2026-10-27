import type { IPieceLibrary, IScene } from './types';
import type { Scene } from './Scene';
import { Scene as SceneModel } from './Scene';

/** Scene settings and the local prompt groups needed to evaluate them.
 * Preset profile PNGs never enter this path: importing scenes must not clone
 * multi-megabyte style images or replace the target project's generation preset.
 */
export interface SceneTransferPlan {
  scenes: IScene[];
  libraries: IPieceLibrary[];
}

function mapStrings<T>(value: T, transform: (text: string) => string): T {
  if (typeof value === 'string') return transform(value) as T;
  if (Array.isArray(value))
    return value.map((item) => mapStrings(item, transform)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapStrings(item, transform),
      ]),
    ) as T;
  return value;
}

function visitStrings(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value))
    value.forEach((item) => visitStrings(item, visit));
  else if (value && typeof value === 'object')
    Object.values(value).forEach((item) => visitStrings(item, visit));
}

function rewriteReferences(
  text: string,
  names: ReadonlyMap<string, string>,
): string {
  return text.replace(
    /<([^<>.]+)\.([^<>.]+)>/g,
    (reference, group: string, piece: string) =>
      names.has(group) ? `<${names.get(group)}.${piece}>` : reference,
  );
}

function comparableLibrary(
  library: IPieceLibrary,
  names: ReadonlyMap<string, string>,
): string {
  return JSON.stringify(
    library.pieces.map((piece) => ({
      name: piece.name,
      prompt: rewriteReferences(piece.prompt, names),
      multi: piece.multi ?? false,
    })),
  );
}

/** Resolve references transitively and reserve all incoming names before renaming.
 * A reused group must also be renamed if one of its dependencies was renamed;
 * otherwise its unchanged text would silently select the target's other group.
 */
export function prepareSceneTransfer(
  sourceScenes: readonly IScene[],
  sourceLibraries: Readonly<Record<string, IPieceLibrary>>,
  targetLibraries: ReadonlyMap<string, IPieceLibrary>,
  externalLibraries: ReadonlyMap<string, IPieceLibrary> = new Map(),
): SceneTransferPlan {
  const sources = new Map<string, IPieceLibrary>();
  const pendingPrompts: string[] = [];
  const collect = (text: string): void => {
    for (const match of text.matchAll(/<([^<>.]+)\.([^<>.]+)>/g)) {
      const [, name, pieceName] = match;
      const local = Object.prototype.hasOwnProperty.call(sourceLibraries, name)
        ? sourceLibraries[name]
        : undefined;
      const global = externalLibraries.get(name);
      let effective = sources.get(name);
      if (
        !effective &&
        (local || global?.pieces.some((piece) => piece.name === pieceName))
      ) {
        effective = {
          name,
          version: local?.version ?? global?.version ?? 1,
          pieces: local ? [...local.pieces] : [],
        };
        sources.set(name, effective);
        pendingPrompts.push(...effective.pieces.map((piece) => piece.prompt));
      }
      // Prompt evaluation falls back per piece, not per group. Snapshot only
      // referenced global pieces so renaming a partial local group stays valid.
      if (
        effective &&
        !effective.pieces.some((piece) => piece.name === pieceName)
      ) {
        const fallback = global?.pieces.find(
          (piece) => piece.name === pieceName,
        );
        if (fallback) {
          effective.pieces.push(fallback);
          pendingPrompts.push(fallback.prompt);
        }
      }
    }
  };
  visitStrings(sourceScenes, collect);
  for (let index = 0; index < pendingPrompts.length; index++)
    collect(pendingPrompts[index]);

  const required = [...sources.keys()];
  const names = new Map<string, string>();
  const externalNames = new Set(externalLibraries.keys());
  const reserved = new Set([
    ...externalNames,
    ...targetLibraries.keys(),
    ...Object.keys(sourceLibraries),
  ]);
  // At most one rename per required group; cycles in piece references terminate.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of required) {
      if (names.has(name)) continue;
      const existing = targetLibraries.get(name);
      if (
        existing
          ? comparableLibrary(sources.get(name)!, names) ===
            comparableLibrary(existing, new Map())
          : !externalNames.has(name)
      )
        continue;
      let suffix = 1;
      while (reserved.has(`${name}_${suffix}`)) suffix++;
      const renamed = `${name}_${suffix}`;
      names.set(name, renamed);
      reserved.add(renamed);
      changed = true;
    }
  }
  const rewrite = (text: string) => rewriteReferences(text, names);
  const libraries: IPieceLibrary[] = [];
  for (const name of required) {
    const destination = names.get(name) ?? name;
    if (targetLibraries.has(destination)) continue;
    const source = sources.get(name)!;
    libraries.push({
      name: destination,
      version: source.version,
      pieces: source.pieces.map((piece) => ({
        name: piece.name,
        prompt: rewrite(piece.prompt),
        multi: piece.multi,
      })),
    });
  }
  return {
    scenes: sourceScenes.map((source) => ({
      ...mapStrings(source, rewrite),
      imageMap: [],
      mains: [],
      game: undefined,
      round: undefined,
    })),
    libraries,
  };
}

/** Keep the existing scene object and all locally generated image ownership.
 * Only its generation settings are replaced, including legacy optional fields.
 */
export function applyImportedSceneSettings(
  target: Scene,
  source: IScene,
): void {
  const replacement = SceneModel.fromJSON(source);
  const images = {
    imageMap: target.imageMap,
    mains: target.mains,
    game: target.game,
    round: target.round,
  };
  Object.assign(target, replacement.toJSON(), {
    slots: replacement.slots,
    meta: replacement.meta,
    sceneSeed: replacement.sceneSeed,
    ...images,
  });
}
