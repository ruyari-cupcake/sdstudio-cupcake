import { observable } from 'mobx';
import type { IScene, PromptPieceSlot, CharacterPrompt } from './types';
import { AbstractScene } from './AbstractScene';
import { PromptPiece } from './PromptPiece';

export class Scene extends AbstractScene implements IScene {
  @observable accessor type: 'scene' = 'scene';

  @observable accessor slots: PromptPieceSlot[] = [];

  @observable accessor meta: Map<string, any> = new Map();

  @observable accessor sceneCharacterPrompts: CharacterPrompt[] = []; // 씬 전용 캐릭터 프롬프트

  @observable accessor useSceneCharacterPrompts: boolean = false; // 씬 전용 캐릭터 프롬프트 사용 여부

  @observable accessor sceneCharacterPromptMode:
    | 'base'
    | 'mix'
    | 'scene'
    | undefined = undefined;

  @observable accessor sceneCharacterUC: string = ''; // 씬 전용 캐릭터 네거티브 프롬프트

  @observable accessor sceneUC: string = ''; // 씬 전용 네거티브 프롬프트 (생성 시 네거티브 뒤에 붙임)

  @observable accessor sceneSeed: number | undefined = undefined; // 씬 전용 시드(2026-09-26)

  static fromJSON(json: IScene): Scene {
    const scene = new Scene();
    Object.assign(scene, json);
    scene.type = 'scene';
    scene.slots = json.slots.map((slot) =>
      slot.map((piece) => PromptPiece.fromJSON(piece)),
    );
    scene.meta = new Map(Object.entries(json.meta ?? {}));
    scene.sceneCharacterPrompts = (json.sceneCharacterPrompts || []).map(
      (cp) => ({
        ...cp,
        enabled: cp.enabled !== false,
      }),
    );
    scene.useSceneCharacterPrompts = json.useSceneCharacterPrompts || false;
    scene.sceneCharacterPromptMode = ['base', 'mix', 'scene'].includes(
      json.sceneCharacterPromptMode || '',
    )
      ? json.sceneCharacterPromptMode
      : undefined;
    scene.sceneCharacterUC = json.sceneCharacterUC || '';
    scene.sceneUC = json.sceneUC || '';
    // 씬 전용 시드: 0~2^32-1 정수만 인정, 그 외(문자열·음수·소수·없음)는 미설정으로(구 데이터·손상 JSON 자가치유)
    const seed = (json as any).sceneSeed;
    scene.sceneSeed =
      typeof seed === 'number' &&
      Number.isInteger(seed) &&
      seed >= 0 &&
      seed <= 0xffffffff
        ? seed
        : undefined;
    return scene;
  }

  toJSON(): IScene {
    return {
      ...super.toJSON(),
      type: this.type,
      slots: this.slots.map((slot) => slot.map((piece) => piece.toJSON())),
      meta: Object.fromEntries(this.meta.entries()),
      sceneCharacterPrompts: this.sceneCharacterPrompts,
      useSceneCharacterPrompts: this.useSceneCharacterPrompts,
      sceneCharacterPromptMode: this.sceneCharacterPromptMode,
      sceneCharacterUC: this.sceneCharacterUC,
      sceneUC: this.sceneUC,
      ...(this.sceneSeed !== undefined ? { sceneSeed: this.sceneSeed } : {}),
    };
  }
}
