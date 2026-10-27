import { observable } from 'mobx';
import type { ICharacterPreset } from './types';
import { VibeItem } from './VibeItem';
import { ReferenceItem } from './ReferenceItem';

export class CharacterPreset implements ICharacterPreset {
  @observable accessor name: string = '';

  @observable accessor characterPrompt: string = '';

  @observable accessor characterUC: string = '';

  @observable accessor backgroundPrompt: string = '';

  @observable accessor vibes: VibeItem[] = [];

  @observable accessor characterReferences: ReferenceItem[] = [];

  // 파일명 옵션 (옵셔널 - 하위 호환성 유지)
  @observable accessor filenamePrefix: string = '';

  @observable accessor filenameSuffix: string = '';

  // 대표 이미지 (옵셔널 - vibes 디렉토리 내 파일명)
  @observable accessor representativeImage: string = '';

  // 글로벌 프리셋 유래 추적 (증식 방지 — ICharacterPreset 주석 참조)
  @observable accessor fromGlobalId: string = '';

  @observable accessor fromGlobalRev: number = 0;

  static fromJSON(json: ICharacterPreset): CharacterPreset {
    const preset = new CharacterPreset();
    preset.name = json.name;
    preset.characterPrompt = json.characterPrompt;
    preset.characterUC = json.characterUC || '';
    preset.backgroundPrompt = json.backgroundPrompt;
    preset.vibes = (json.vibes || []).map((v) => VibeItem.fromJSON(v));
    preset.characterReferences = (json.characterReferences || []).map(
      (r) => ReferenceItem.fromJSON(r) as ReferenceItem,
    );
    // 파일명 옵션 로드 (하위 호환성: 없으면 빈 문자열)
    preset.filenamePrefix = json.filenamePrefix || '';
    preset.filenameSuffix = json.filenameSuffix || '';
    preset.representativeImage = json.representativeImage || '';
    preset.fromGlobalId = json.fromGlobalId || '';
    preset.fromGlobalRev = json.fromGlobalRev || 0;
    return preset;
  }

  toJSON(): ICharacterPreset {
    return {
      name: this.name,
      characterPrompt: this.characterPrompt,
      characterUC: this.characterUC,
      backgroundPrompt: this.backgroundPrompt,
      vibes: this.vibes.map((v) => v.toJSON()),
      characterReferences: this.characterReferences.map((r) => r.toJSON()),
      // 파일명 옵션 저장 (빈 문자열이면 undefined로 저장하여 JSON 크기 최소화)
      filenamePrefix: this.filenamePrefix || undefined,
      filenameSuffix: this.filenameSuffix || undefined,
      representativeImage: this.representativeImage || undefined,
      fromGlobalId: this.fromGlobalId || undefined,
      fromGlobalRev: this.fromGlobalRev || undefined,
    };
  }
}
