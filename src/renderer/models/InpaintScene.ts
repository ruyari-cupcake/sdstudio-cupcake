import { observable } from 'mobx';
import type { IInpaintScene, PromptPieceSlot } from './types';
import { AbstractScene } from './AbstractScene';
import { PromptPiece } from './PromptPiece';
import { workFlowService } from './workflows/workflowRegistry';
import { normalizeComboMode, type ComboMode } from './comboMode';

export class InpaintScene extends AbstractScene implements IInpaintScene {
  @observable accessor type: 'inpaint' = 'inpaint';

  @observable accessor workflowType: string = '';

  @observable accessor preset: any | undefined = undefined;

  @observable accessor sceneRef: string | undefined = undefined;

  @observable accessor sourceImage: string | undefined = undefined;

  @observable accessor slots: PromptPieceSlot[] = [];

  @observable accessor mirrorCropX: number | undefined = undefined;

  @observable accessor comboMode: ComboMode | undefined = undefined;

  static fromJSON(json: IInpaintScene): InpaintScene | null {
    const scene = new InpaintScene();
    Object.assign(scene, json);
    scene.type = 'inpaint';
    try {
      scene.preset = json.preset && workFlowService.presetFromJSON(json.preset);
      if (json.preset && !scene.preset) return null;
    } catch (e) {
      console.warn(`Failed to deserialize inpaint scene: ${json.name}`, e);
      return null;
    }
    scene.slots = (json.slots || []).map((slot) =>
      slot.map((piece) => PromptPiece.fromJSON(piece)),
    );
    // 알 수 없는 값·손상값은 조합 모드 아님(단일 프롬프트로 동작)
    scene.comboMode = normalizeComboMode(json.comboMode);
    return scene;
  }

  toJSON(): IInpaintScene {
    return {
      ...super.toJSON(),
      type: this.type,
      workflowType: this.workflowType,
      preset: this.preset?.toJSON(),
      sceneRef: this.sceneRef,
      sourceImage: this.sourceImage,
      ...(this.slots.length > 0 && {
        slots: this.slots.map((slot) => slot.map((piece) => piece.toJSON())),
      }),
      ...(this.mirrorCropX != null && { mirrorCropX: this.mirrorCropX }),
      ...(this.comboMode && { comboMode: this.comboMode }),
    };
  }
}
