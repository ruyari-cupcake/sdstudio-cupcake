import { observable } from 'mobx';
import type { IPiece } from './types';

export class Piece implements IPiece {
  @observable accessor name: string = '';

  @observable accessor prompt: string = '';

  @observable accessor multi: boolean | undefined = undefined;

  static fromJSON(json: IPiece): Piece {
    const piece = new Piece();
    Object.assign(piece, json);
    return piece;
  }

  toJSON(): IPiece {
    return {
      name: this.name,
      prompt: this.prompt,
      multi: this.multi,
    };
  }
}
