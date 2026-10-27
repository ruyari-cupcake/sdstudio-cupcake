import { observable } from 'mobx';
import type { IReferenceItem } from './types';

export class ReferenceItem implements IReferenceItem {
  @observable accessor path: string = '';

  @observable accessor info: number = 1.0;

  @observable accessor strength: number = 0.6;

  @observable accessor fidelity: number = 1.0;

  @observable accessor referenceType:
    | 'character'
    | 'style'
    | 'character&style' = 'character';

  @observable accessor enabled: boolean = true;

  @observable accessor fromPreset: string | undefined = undefined;

  static fromJSON(json: IReferenceItem): ReferenceItem {
    const item = new ReferenceItem();
    if (json) {
      item.path = json.path || '';
      item.info = json.info ?? 1.0;
      item.strength = json.strength ?? 0.6;
      item.fidelity = json.fidelity ?? 1.0;
      item.referenceType = json.referenceType || 'character';
      item.enabled = json.enabled ?? true;
      item.fromPreset = json.fromPreset;
    }
    return item;
  }

  toJSON(): IReferenceItem {
    return {
      path: this.path,
      info: this.info,
      strength: this.strength,
      fidelity: this.fidelity,
      referenceType: this.referenceType,
      enabled: this.enabled,
      fromPreset: this.fromPreset,
    };
  }
}
