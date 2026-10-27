import { action, observable, makeObservable } from 'mobx';
import type { SelectedWorkflow, GenericScene, ISession } from './types';
import type { Serealizable } from './ResourceSyncService';
import type { WorkFlowDef } from './workflows/WorkFlow';
import { workFlowService } from './workflows/workflowRegistry';
import { InpaintScene } from './InpaintScene';
import { Scene } from './Scene';
import { PieceLibrary } from './PieceLibrary';
import { CharacterPreset } from './CharacterPreset';

export class Session implements Serealizable {
  @observable accessor version: number = 1;

  @observable accessor name: string = '';

  // 세션 전역 유일 식별자(uuid v4). 트랙1 (b) 물리 통합의 폴더명(정제이름__짧은id)·
  // meta.json 근거. 로드 경로(SessionService.migrate)에서 없으면 지연 발급된다.
  @observable accessor id: string | undefined = undefined;

  @observable accessor selectedWorkflow: SelectedWorkflow | undefined =
    undefined;

  @observable accessor presets: Map<string, any[]> = new Map();

  @observable accessor inpaints: Map<string, InpaintScene> = new Map();

  @observable accessor scenes: Map<string, Scene> = new Map();

  @observable accessor library: Map<string, PieceLibrary> = new Map();

  @observable accessor presetShareds: Map<string, any> = new Map();

  @observable accessor characterPresets: Map<string, CharacterPreset> =
    new Map(); // 캐릭터 프리셋

  @observable accessor mirrorImage: string | undefined = undefined;

  @observable accessor mirrorMode: 'blank' | 'duplicate' = 'blank';

  @observable accessor sceneCardStyle: { scene?: string; inpaint?: string } =
    {};

  @observable accessor newSceneResolution:
    | { resolution: string; width?: number; height?: number }
    | undefined = undefined;

  // 추가 프롬프트 (2026-07-18) — 상위와 중위(씬 전용) 사이에 끼는 스크래치 프롬프트.
  // **세션(프로젝트) 귀속 필드**로만 저장한다: 프리셋·글로벌 프리셋 등 기존 프롬프트
  // 저장 구조에는 의도적으로 넣지 않는다(프리셋 전환/글로벌화와 무관하게 유지, 사용자
  // 확정 2026-07-18). 조합 반영은 PromptService.createSDPrompts 단일 지점.
  @observable accessor extraPrompt: string = '';

  constructor() {
    makeObservable(this);
  }

  hasScene(type: 'scene' | 'inpaint', name: string): boolean {
    if (type === 'scene') {
      return this.scenes.has(name);
    }
    return this.inpaints.has(name);
  }

  @action
  addScene(scene: GenericScene): void {
    if (scene.type === 'scene') {
      this.scenes.set(scene.name, scene);
    } else {
      this.inpaints.set(scene.name, scene);
    }
  }

  getScene(type: 'scene' | 'inpaint', name: string): GenericScene | undefined {
    if (type === 'scene') {
      return this.scenes.get(name);
    }
    return this.inpaints.get(name);
  }

  @action
  removeScene(type: 'scene' | 'inpaint', name: string): void {
    if (type === 'scene') {
      this.scenes.delete(name);
    } else {
      this.inpaints.delete(name);
    }
  }

  moveScene(targetScene: GenericScene, index: number) {
    const scenes = this.getScenes(targetScene.type);
    const reorderedScenes = scenes.filter((scene) => scene !== targetScene);
    reorderedScenes.splice(index, 0, targetScene);
    const final = reorderedScenes.reduce((acc, scene) => {
      acc.set(scene.name, scene);
      return acc;
    }, new Map()) as any;
    if (targetScene.type === 'scene') {
      this.scenes = final;
    } else {
      this.inpaints = final;
    }
  }

  @action
  movePreset(type: string, fromIndex: number, toIndex: number) {
    const presetList = this.presets.get(type);
    if (!presetList) return;
    if (fromIndex < 0 || fromIndex >= presetList.length) return;
    if (toIndex < 0 || toIndex >= presetList.length) return;
    if (fromIndex === toIndex) return;
    const [moved] = presetList.splice(fromIndex, 1);
    presetList.splice(toIndex, 0, moved);
    // MobX 반응성 트리거를 위해 새 배열로 교체
    this.presets.set(type, [...presetList]);
  }

  hasPreset(type: string, name: string): boolean {
    return (
      this.presets.get(type)?.some((preset) => preset.name === name) ?? false
    );
  }

  getPreset(type: string, name: string): any | undefined {
    return this.presets.get(type)?.find((preset) => preset.name === name);
  }

  @action
  addPreset(preset: any): void {
    const presets = this.presets.get(preset.type) || [];
    const existingNames = new Set(presets.map((item) => item.name));
    if (existingNames.has(preset.name)) {
      let i = 1;
      while (existingNames.has(`${preset.name}${i}`)) {
        i++;
      }
      preset.name += i.toString();
    }
    presets.push(preset);
    this.presets.set(preset.type, presets);
  }

  @action
  removePreset(type: string, name: string): void {
    const presets = this.presets.get(type) || [];
    this.presets.set(
      type,
      presets.filter((preset) => preset.name !== name),
    );
  }

  getScenes(type: 'scene' | 'inpaint'): GenericScene[] {
    if (type === 'scene') {
      return Array.from(this.scenes.values());
    }
    return Array.from(this.inpaints.values());
  }

  getCommonSetup(flow: SelectedWorkflow): [string, any, any, WorkFlowDef] {
    const type = flow.workflowType;
    const preset = flow.presetName && this.getPreset(type, flow.presetName);
    const shared = this.presetShareds.get(type);
    const def = workFlowService.getDef(type)!;
    return [type, preset, shared, def];
  }

  // 캐릭터 프리셋 관리 메서드
  hasCharacterPreset(name: string): boolean {
    return this.characterPresets.has(name);
  }

  getCharacterPreset(name: string): CharacterPreset | undefined {
    return this.characterPresets.get(name);
  }

  getCharacterPresets(): CharacterPreset[] {
    return Array.from(this.characterPresets.values());
  }

  @action
  addCharacterPreset(preset: CharacterPreset): void {
    // 이름 중복 처리
    if (this.characterPresets.has(preset.name)) {
      let i = 1;
      while (this.characterPresets.has(preset.name + i.toString())) {
        i++;
      }
      preset.name += i.toString();
    }
    this.characterPresets.set(preset.name, preset);
  }

  @action
  updateCharacterPreset(oldName: string, preset: CharacterPreset): void {
    if (oldName !== preset.name) {
      this.characterPresets.delete(oldName);
    }
    this.characterPresets.set(preset.name, preset);
  }

  @action
  removeCharacterPreset(name: string): void {
    this.characterPresets.delete(name);
  }

  @action
  moveCharacterPreset(fromIndex: number, toIndex: number): void {
    const entries = Array.from(this.characterPresets.entries());
    if (fromIndex < 0 || fromIndex >= entries.length) return;
    if (toIndex < 0 || toIndex >= entries.length) return;
    if (fromIndex === toIndex) return;
    const [moved] = entries.splice(fromIndex, 1);
    entries.splice(toIndex, 0, moved);
    this.characterPresets = new Map(entries);
  }

  static fromJSON(json: ISession): Session {
    const session = new Session();
    session.name = json.name;
    session.version = json.version;
    session.id = json.id; // 있으면 유지(없으면 undefined → 로드 시 지연 발급)
    session.selectedWorkflow = json.selectedWorkflow;
    session.presets = new Map(
      Object.entries(json.presets).map(([key, value]) => [
        key,
        value
          .map((preset) => workFlowService.presetFromJSON(preset))
          .filter(Boolean),
      ]),
    );
    session.inpaints = new Map(
      Object.entries(json.inpaints)
        .map(([key, value]) => [key, InpaintScene.fromJSON(value)] as const)
        .filter(([_, scene]) => scene !== null) as [string, InpaintScene][],
    );
    session.scenes = new Map(
      Object.entries(json.scenes).map(([key, value]) => [
        key,
        Scene.fromJSON(value),
      ]),
    );
    session.library = new Map(
      Object.entries(json.library).map(([key, value]) => [
        key,
        PieceLibrary.fromJSON(value),
      ]),
    );
    session.presetShareds = new Map(
      Object.entries(json.presetShareds).map(([key, value]) => [
        key,
        workFlowService.sharedFromJSON(value),
      ]),
    );
    // 캐릭터 프리셋 로드
    session.characterPresets = new Map(
      Object.entries(json.characterPresets || {}).map(([key, value]) => [
        key,
        CharacterPreset.fromJSON(value),
      ]),
    );
    session.mirrorImage = json.mirrorImage;
    session.mirrorMode = json.mirrorMode || 'blank';
    session.sceneCardStyle = json.sceneCardStyle || {};
    session.newSceneResolution = json.newSceneResolution;
    session.extraPrompt = json.extraPrompt || '';
    return session;
  }

  fromJSON(json: ISession): Session {
    return Session.fromJSON(json);
  }

  toJSON(): ISession {
    return {
      name: this.name,
      version: this.version,
      id: this.id,
      selectedWorkflow: this.selectedWorkflow,
      presets: Object.fromEntries(
        Array.from(this.presets.entries()).map(([key, value]) => [
          key,
          value.map((preset) => preset.toJSON()),
        ]),
      ),
      inpaints: Object.fromEntries(
        Array.from(this.inpaints.entries()).map(([key, value]) => [
          key,
          value.toJSON(),
        ]),
      ),
      scenes: Object.fromEntries(
        Array.from(this.scenes.entries()).map(([key, value]) => [
          key,
          value.toJSON(),
        ]),
      ),
      library: Object.fromEntries(
        Array.from(this.library.entries()).map(([key, value]) => [
          key,
          value.toJSON(),
        ]),
      ),
      presetShareds: Object.fromEntries(
        Array.from(this.presetShareds.entries()).map(([key, value]) => [
          key,
          value.toJSON(),
        ]),
      ),
      // 캐릭터 프리셋 저장
      characterPresets: Object.fromEntries(
        Array.from(this.characterPresets.entries()).map(([key, value]) => [
          key,
          value.toJSON(),
        ]),
      ),
      mirrorImage: this.mirrorImage,
      mirrorMode: this.mirrorMode,
      sceneCardStyle: this.sceneCardStyle,
      newSceneResolution: this.newSceneResolution,
      // 빈 값은 필드 생략 — 미사용 프로젝트의 JSON 을 오염시키지 않는다
      extraPrompt: this.extraPrompt || undefined,
    };
  }
}
