import {
  applyImportedSceneSettings,
  prepareSceneTransfer,
} from '../sceneTransfer';
import type { SceneTransferPlan } from '../sceneTransfer';
import { Scene } from '../Scene';
import type { IPieceLibrary, IScene } from '../types';

const scene = (prompt: string): IScene => ({
  type: 'scene',
  name: 'smile',
  resolution: 'portrait',
  slots: [
    [{ id: 'owned-test-choice', prompt, enabled: true, characterPrompts: [] }],
  ],
  imageMap: [],
  mains: [],
  meta: {},
});
const group = (
  name: string,
  pieces: Record<string, string>,
): IPieceLibrary => ({
  name,
  version: 1,
  pieces: Object.entries(pieces).map(([pieceName, prompt]) => ({
    name: pieceName,
    prompt,
    multi: false,
  })),
});
const transfer = (
  scenes: IScene[],
  local: Record<string, IPieceLibrary>,
  target: Map<string, IPieceLibrary>,
  global: Map<string, IPieceLibrary>,
): SceneTransferPlan => prepareSceneTransfer(scenes, local, target, global);
function referencePiece(
  reference: string,
  groups: ReadonlyMap<string, IPieceLibrary>,
) {
  const match = /^<([^<>.]+)\.([^<>.]+)>$/.exec(reference);
  expect(match).not.toBeNull();
  return groups
    .get(match![1])
    ?.pieces.find((piece) => piece.name === match![2]);
}

describe('imported scene settings and global fallback ownership', () => {
  it('clears an old fixed seed when the incoming legacy scene has no seed', () => {
    const existing = Scene.fromJSON({
      ...scene('old'),
      sceneSeed: 123,
      imageMap: ['owned.png'],
      mains: ['owned.png'],
    });
    applyImportedSceneSettings(existing, scene('incoming'));
    expect(existing.sceneSeed).toBeUndefined();
    expect(existing.toJSON()).not.toHaveProperty('sceneSeed');
    expect(existing.slots[0][0].prompt).toBe('incoming');
    expect(existing.imageMap).toEqual(['owned.png']);
    expect(existing.mains).toEqual(['owned.png']);
  });
  it('preserves a global fallback piece when its partially local group is renamed', () => {
    const local = { a: group('a', { x: 'source-local-x' }) };
    const global = new Map([['a', group('a', { y: 'source-global-y' })]]);
    const target = new Map([['a', group('a', { y: 'existing-target-y' })]]);
    const plan = transfer([scene('<a.y>')], local, target, global);
    const imported = new Map([
      ...target,
      ...plan.libraries.map((library) => [library.name, library] as const),
    ]);
    const reference = plan.scenes[0].slots[0][0].prompt;
    expect(reference).not.toBe('<a.y>');
    expect(referencePiece(reference, imported)?.prompt).toBe('source-global-y');
    expect(target.get('a')?.pieces).toEqual([
      { name: 'y', prompt: 'existing-target-y', multi: false },
    ]);
    expect(local.a.pieces).toEqual([
      { name: 'x', prompt: 'source-local-x', multi: false },
    ]);
    expect(global.get('a')?.pieces).toEqual([
      { name: 'y', prompt: 'source-global-y', multi: false },
    ]);
  });
  it('preserves transitive global fallback dependencies instead of resolving target-local text', () => {
    const local = { a: group('a', { x: '<b.y>' }) };
    const global = new Map([
      ['b', group('b', { y: '<c.z>' })],
      ['c', group('c', { z: 'original-global-leaf' })],
    ]);
    const target = new Map([
      ['b', group('b', { y: 'target-b-y' })],
      ['c', group('c', { z: 'target-c-z' })],
    ]);
    const plan = transfer([scene('<a.x>')], local, target, global);
    const imported = new Map([
      ...target,
      ...plan.libraries.map((library) => [library.name, library] as const),
    ]);
    const first = referencePiece(plan.scenes[0].slots[0][0].prompt, imported);
    const middle = referencePiece(first!.prompt, imported);
    expect(middle?.prompt).toMatch(/^<[^<>.]+\.z>$/);
    expect(referencePiece(middle!.prompt, imported)?.prompt).toBe(
      'original-global-leaf',
    );
    expect(target.get('b')?.pieces[0].prompt).toBe('target-b-y');
    expect(target.get('c')?.pieces[0].prompt).toBe('target-c-z');
    expect(local.a.pieces[0].prompt).toBe('<b.y>');
  });
});
