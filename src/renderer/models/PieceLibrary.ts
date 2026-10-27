import { observable } from 'mobx';
import type { IPieceLibrary } from './types';
import { Piece } from './Piece';

export class PieceLibrary implements IPieceLibrary {
  @observable accessor version: number = 1;

  @observable accessor name: string = '';

  @observable accessor pieces: Piece[] = [];

  static fromJSON(json: IPieceLibrary): PieceLibrary {
    const library = new PieceLibrary();
    library.version = json.version;
    library.name = json.name;
    library.pieces = json.pieces.map((piece) => Piece.fromJSON(piece));
    return library;
  }

  toJSON(): IPieceLibrary {
    return {
      name: this.name,
      version: this.version,
      pieces: this.pieces.map((piece) => piece.toJSON()),
    };
  }
}
