import { observable } from 'mobx';
import type { IAbstractScene, Game, Round } from './types';

export class AbstractScene implements IAbstractScene {
  @observable accessor name: string = '';

  @observable accessor resolution: string = '';

  @observable accessor resolutionWidth: number | undefined = undefined;

  @observable accessor resolutionHeight: number | undefined = undefined;

  @observable.shallow accessor game: Game | undefined = undefined;

  @observable.ref accessor round: Round | undefined = undefined;

  @observable.shallow accessor imageMap: string[] = [];

  @observable accessor mains: string[] = [];

  // 반환 타입에 null 포함: InpaintScene.fromJSON 이 역직렬화 실패 시 null 을
  // 반환하므로 서브클래스 정적 시그니처와의 호환을 위해 필요.
  static fromJSON(json: IAbstractScene): AbstractScene | null {
    const scene = new AbstractScene();
    scene.name = json.name;
    scene.resolution = json.resolution;
    scene.game = json.game;
    scene.round = json.round;
    scene.imageMap = json.imageMap;
    scene.mains = json.mains;
    scene.resolutionWidth = json.resolutionWidth;
    scene.resolutionHeight = json.resolutionHeight;
    return scene;
  }

  toJSON(): IAbstractScene {
    return {
      name: this.name,
      resolution: this.resolution,
      game: this.game,
      round: this.round,
      imageMap: this.imageMap,
      mains: this.mains,
      resolutionHeight: this.resolutionHeight,
      resolutionWidth: this.resolutionWidth,
    };
  }
}
