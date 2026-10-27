import { observable } from 'mobx';
import type { IPromptPiece } from './types';

export class PromptPiece implements IPromptPiece {
  @observable accessor prompt: string = '';

  @observable accessor characterPrompts: string[] = [];

  @observable accessor id: string = '';

  @observable accessor enabled: boolean | undefined = undefined;

  @observable accessor name: string | undefined = undefined;

  static fromJSON(json: IPromptPiece): PromptPiece {
    const promptPiece = new PromptPiece();
    Object.assign(promptPiece, json);
    // Ensure characterPrompts is always an array
    if (!Array.isArray(promptPiece.characterPrompts)) {
      promptPiece.characterPrompts = [];
    }
    return promptPiece;
  }

  toJSON(): IPromptPiece {
    return {
      prompt: this.prompt,
      characterPrompts: [...(this.characterPrompts || [])],
      id: this.id,
      enabled: this.enabled,
      // 이름은 값이 있을 때만 직렬화 — 기존 저장 파일 오염 방지(하위호환).
      ...(this.name ? { name: this.name } : {}),
    };
  }
}
