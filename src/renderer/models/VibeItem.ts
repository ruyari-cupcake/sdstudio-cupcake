import { observable } from 'mobx';
import type { IVibeItem } from './types';

export class VibeItem implements IVibeItem {
  @observable accessor path: string = '';

  @observable accessor info: number = 0;

  @observable accessor strength: number = 0;

  @observable accessor fromPreset: string | undefined = undefined;

  static fromJSON(json: IVibeItem): VibeItem {
    const item = new VibeItem();
    Object.assign(item, json);
    return item;
  }

  toJSON(): IVibeItem {
    return {
      path: this.path,
      info: this.info,
      strength: this.strength,
      fromPreset: this.fromPreset,
    };
  }
}
