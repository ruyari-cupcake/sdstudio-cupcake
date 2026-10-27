import { observable, action } from 'mobx';
import { persistService } from './PersistenceService';
import { PieceLibrary, type IPieceLibrary } from './types';
import type { Backend } from '../backend';

type GlobalPieceBackend = Pick<Backend, 'readFile' | 'writeFile'>;

const GLOBAL_PIECES_FILE = 'global_pieces.json';

export class GlobalPieceService {
  constructor(private readonly backend: GlobalPieceBackend) {
    // Storage is explicit; construction performs no IO.
  }

  @observable accessor library: Map<string, PieceLibrary> = new Map();

  private saveTimeout: any = null;

  async load() {
    try {
      const str = await this.backend.readFile(GLOBAL_PIECES_FILE);
      const json: Record<string, IPieceLibrary> = JSON.parse(str);
      this.library = new Map(
        Object.entries(json).map(([key, value]) => [
          key,
          PieceLibrary.fromJSON(value),
        ]),
      );
    } catch {
      this.library = new Map();
    }
  }

  async save() {
    const json: Record<string, any> = {};
    for (const [key, value] of this.library.entries()) {
      json[key] = value.toJSON();
    }
    await persistService.write(
      this.backend,
      GLOBAL_PIECES_FILE,
      JSON.stringify(json),
    );
  }

  scheduleSave() {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.save(), 2000);
  }

  async flushSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.save();
  }

  @action
  addLibrary(name: string, lib: PieceLibrary) {
    this.library.set(name, lib);
    this.scheduleSave();
  }

  @action
  deleteLibrary(name: string) {
    this.library.delete(name);
    this.scheduleSave();
  }
}
