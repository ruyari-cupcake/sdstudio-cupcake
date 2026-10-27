import { observable, action } from 'mobx';
import { v4 as uuidv4 } from 'uuid';
import { persistService } from './PersistenceService';
import { StoreLoadGuard } from './StoreLoadGuard';
import type { Backend } from '../backend';
import { imageExtFromBase64 } from './imageFormats';
import { extractPromptDataFromBase64 } from './util';
import {
  type ModelSamplingFamily,
  samplingFamilyForModelId,
} from './modelSamplingProfiles';

type ArtistLibraryBackend = Pick<
  Backend,
  | 'readFile'
  | 'writeFile'
  | 'renameFile'
  | 'copyFile'
  | 'deleteFile'
  | 'deleteDir'
  | 'writeDataFile'
  | 'existFile'
>;

// 작가 라이브러리 전역 데이터.
// 프로젝트(세션)와 무관하게 앱 루트의 artist_library.json + artist_library/ 폴더에 저장.
// 프로젝트/씬 타입을 건드리지 않으므로 구버전 앱과의 데이터 호환성에 영향 없음.
const ARTIST_LIBRARY_FILE = 'artist_library.json';
export const ARTIST_LIBRARY_DIR = 'artist_library';

export interface IArtistImage {
  id: string;
  path: string; // artist_library/<artistId>/<imageId>.png
  /** 샘플이 나온 NAI 모델 계열(v4_5|v5). 추가 시 메타데이터로 자동 판정, 없으면 미지정(2026-09-26 선택 필드 — 예전 파일 호환). */
  family?: ModelSamplingFamily;
}

/** 작가 라이브러리 탭은 메인 탭 묶음의 4번째(shortcut-action 'tab-4'). App.tsx 탭 순서와 함께 유지. */
export const ARTIST_LIBRARY_TAB_ACTION = 'tab-4';

/** 이미지 메타데이터(naiDiagnostics.model)로 모델 계열을 판정한다. 못 읽으면 undefined. */
export async function detectImageFamily(
  base64: string,
): Promise<ModelSamplingFamily | undefined> {
  try {
    const meta = await extractPromptDataFromBase64(base64);
    return samplingFamilyForModelId(meta?.naiDiagnostics?.model);
  } catch {
    return undefined;
  }
}

export interface IArtistEntry {
  id: string;
  name: string;
  images: IArtistImage[]; // [0] = 대표 썸네일
  tags: string[]; // 자유 태그 (예: "#러프")
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
}

interface IArtistLibraryStore {
  version: 1;
  artists: IArtistEntry[];
  tagPresets: string[]; // 클릭 추가용 태그 프리셋 팔레트
}

export class ArtistLibraryService extends EventTarget {
  constructor(private readonly backend: ArtistLibraryBackend) {
    super();
  }

  @observable accessor artists: IArtistEntry[] = [];

  @observable accessor tagPresets: string[] = [];

  @observable accessor loaded: boolean = false;

  private readonly loadGuard = new StoreLoadGuard();

  private saveTimeout: any = null;

  // ---------- lifecycle ----------

  async load(): Promise<void> {
    this.loaded = false;
    await this.loadGuard.run(async () => {
      if (!(await this.backend.existFile(ARTIST_LIBRARY_FILE))) {
        this.artists = [];
        this.tagPresets = [];
        return;
      }
      const str = await this.backend.readFile(ARTIST_LIBRARY_FILE);
      let json: IArtistLibraryStore;
      try {
        json = JSON.parse(str) as IArtistLibraryStore;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        await this.backend.renameFile(
          ARTIST_LIBRARY_FILE,
          `${ARTIST_LIBRARY_FILE}.corrupt-${Date.now()}`,
        );
        this.artists = [];
        this.tagPresets = [];
        return;
      }
      this.artists = Array.isArray(json?.artists)
        ? json.artists.filter(
            (artist) =>
              artist &&
              typeof artist.id === 'string' &&
              typeof artist.name === 'string' &&
              Array.isArray(artist.images) &&
              Array.isArray(artist.tags),
          )
        : [];
      this.tagPresets = Array.isArray(json?.tagPresets)
        ? json.tagPresets.filter((tag) => typeof tag === 'string')
        : [];
    });
    this.loaded = true;
    this.dispatchEvent(new CustomEvent('loaded', {}));
  }

  async save(
    artists: IArtistEntry[] = this.artists,
    tagPresets: string[] = this.tagPresets,
  ): Promise<void> {
    await this.writeStoreOrThrow(artists, tagPresets);
  }

  private async writeStoreOrThrow(
    artists: IArtistEntry[] = this.artists,
    tagPresets: string[] = this.tagPresets,
  ): Promise<void> {
    this.loadGuard.assertWritable();
    const store: IArtistLibraryStore = {
      version: 1,
      artists,
      tagPresets,
    };
    const data = JSON.stringify(store);
    await persistService.writeAtomic(this.backend, ARTIST_LIBRARY_FILE, data);
  }

  scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      void this.save().catch((error) => {
        console.error('작가 라이브러리 저장 실패:', error);
      });
    }, 1500);
  }

  async flushSave(
    artists: IArtistEntry[] = this.artists,
    tagPresets: string[] = this.tagPresets,
  ): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.save(artists, tagPresets);
  }

  // ---------- artists ----------

  getArtist(id: string): IArtistEntry | undefined {
    return this.artists.find((a) => a.id === id);
  }

  private static normalizeArtistName(name: string): string {
    return name.trim().replace(/\s+/g, ' ');
  }

  private static artistNameKey(name: string): string {
    return ArtistLibraryService.normalizeArtistName(name).toLowerCase();
  }

  findArtistByName(name: string, excludeId?: string): IArtistEntry | undefined {
    const key = ArtistLibraryService.artistNameKey(name);
    if (!key) return undefined;
    return this.artists
      .filter(
        (a) =>
          a.id !== excludeId &&
          ArtistLibraryService.artistNameKey(a.name) === key,
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  getDuplicateArtistGroups(): IArtistEntry[][] {
    const groups = new Map<string, IArtistEntry[]>();
    for (const artist of this.artists) {
      const key = ArtistLibraryService.artistNameKey(artist.name);
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push(artist);
      groups.set(key, group);
    }
    return Array.from(groups.values()).filter((group) => group.length > 1);
  }

  @action
  createArtist(nameInput: string): IArtistEntry | undefined {
    const name = ArtistLibraryService.normalizeArtistName(nameInput);
    if (!name) return undefined;
    const existing = this.findArtistByName(name);
    if (existing) return existing;
    const entry: IArtistEntry = {
      id: uuidv4(),
      name,
      images: [],
      tags: [],
      favorite: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.artists = [...this.artists, entry];
    this.scheduleSave();
    return entry;
  }

  @action
  renameArtist(id: string, nameInput: string): void {
    const a = this.getArtist(id);
    if (!a) return;
    const name = ArtistLibraryService.normalizeArtistName(nameInput);
    if (!name || a.name === name) return;
    if (this.findArtistByName(name, id)) return;
    a.name = name;
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
  }

  // 기존 동명 카드를 사용자가 명시적으로 요청했을 때만 일괄 병합한다.
  // 파일은 대상 폴더로 전부 복사하고 JSON 저장까지 성공한 뒤 원본 폴더를 지운다.
  @action
  async mergeDuplicateArtists(
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ groups: number; mergedArtists: number; copiedImages: number }> {
    const groups = this.getDuplicateArtistGroups();
    if (groups.length === 0) {
      return { groups: 0, mergedArtists: 0, copiedImages: 0 };
    }

    const originalArtists = this.artists;
    let nextArtists = [...this.artists];
    const copiedPaths: string[] = [];
    const sourceDirs: string[] = [];
    let mergedArtists = 0;

    try {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = [...groups[groupIndex]].sort(
          (a, b) =>
            (a.createdAt ?? Number.MAX_SAFE_INTEGER) -
            (b.createdAt ?? Number.MAX_SAFE_INTEGER),
        );
        const target = group[0];
        const sources = group.slice(1);
        const copiedImages: IArtistImage[] = [];

        for (const source of sources) {
          for (const image of source.images) {
            const imageId = uuidv4();
            const ext = image.path.split('.').pop() || 'png';
            const dest = `${ARTIST_LIBRARY_DIR}/${target.id}/${imageId}.${ext}`;
            await this.backend.copyFile(image.path, dest);
            copiedPaths.push(dest);
            copiedImages.push({ id: imageId, path: dest });
          }
          sourceDirs.push(`${ARTIST_LIBRARY_DIR}/${source.id}`);
        }

        const merged: IArtistEntry = {
          ...target,
          images: [...target.images, ...copiedImages],
          tags: Array.from(new Set(group.flatMap((a) => a.tags))),
          favorite: group.some((a) => a.favorite),
          createdAt: Math.min(...group.map((a) => a.createdAt ?? Date.now())),
          updatedAt: Date.now(),
        };
        const sourceIds = new Set(sources.map((a) => a.id));
        nextArtists = nextArtists
          .filter((a) => !sourceIds.has(a.id))
          .map((a) => (a.id === target.id ? merged : a));
        mergedArtists += sources.length;
        onProgress?.(groupIndex + 1, groups.length);
      }

      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        this.saveTimeout = null;
      }
      this.artists = nextArtists;
      await this.writeStoreOrThrow();
    } catch (e) {
      this.artists = originalArtists;
      for (const path of copiedPaths) {
        try {
          await this.backend.deleteFile(path);
        } catch (cleanupError) {
          console.warn('작가 이미지 병합 취소 정리 실패:', path, cleanupError);
        }
      }
      throw e;
    }

    for (const dir of sourceDirs) {
      try {
        await this.backend.deleteDir(dir);
      } catch (error) {
        console.warn('병합된 작가 이미지 폴더 정리 실패:', dir, error);
      }
    }

    return {
      groups: groups.length,
      mergedArtists,
      copiedImages: copiedPaths.length,
    };
  }

  @action
  async deleteArtist(id: string): Promise<void> {
    const a = this.getArtist(id);
    if (!a) return;
    this.artists = this.artists.filter((x) => x.id !== id);
    this.scheduleSave();
    try {
      await this.backend.deleteDir(`${ARTIST_LIBRARY_DIR}/${id}`);
    } catch (error) {
      console.warn('삭제된 작가 이미지 폴더 정리 실패:', id, error);
    }
  }

  @action
  toggleFavorite(id: string): void {
    const a = this.getArtist(id);
    if (!a) return;
    a.favorite = !a.favorite;
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
  }

  // ---------- images ----------

  // base64(원본 PNG 바이트) 첨부. 메타데이터 보존을 위해 그대로 저장.
  @action
  async addImage(
    id: string,
    base64: string,
    family?: ModelSamplingFamily,
  ): Promise<void> {
    const a = this.getArtist(id);
    if (!a) return;
    const detected = family ?? (await detectImageFamily(base64));
    const imageId = uuidv4();
    const ext = imageExtFromBase64(base64);
    const path = `${ARTIST_LIBRARY_DIR}/${id}/${imageId}.${ext}`;
    try {
      await this.backend.writeDataFile(path, base64);
    } catch (e) {
      console.error('Failed to store artist image:', e);
      return;
    }
    a.images = [
      ...a.images,
      detected
        ? { id: imageId, path, family: detected }
        : { id: imageId, path },
    ];
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
  }

  // 샘플 이미지의 모델 계열을 수동 지정/해제한다(2026-09-26).
  @action
  setImageFamily(
    id: string,
    imageId: string,
    family: ModelSamplingFamily | undefined,
  ): void {
    const a = this.getArtist(id);
    if (!a) return;
    a.images = a.images.map((img) => {
      if (img.id !== imageId) return img;
      const next: IArtistImage = { id: img.id, path: img.path };
      if (family) next.family = family;
      return next;
    });
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
  }

  @action
  async removeImage(id: string, imageId: string): Promise<void> {
    const a = this.getArtist(id);
    if (!a) return;
    const img = a.images.find((i) => i.id === imageId);
    a.images = a.images.filter((i) => i.id !== imageId);
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
    if (img) {
      try {
        await this.backend.deleteFile(img.path);
      } catch (error) {
        console.warn('제거된 작가 이미지 파일 정리 실패:', img.path, error);
      }
    }
  }

  // 대표 썸네일 지정 — 해당 이미지를 맨 앞으로.
  @action
  setThumbnail(id: string, imageId: string): void {
    const a = this.getArtist(id);
    if (!a) return;
    const idx = a.images.findIndex((i) => i.id === imageId);
    if (idx <= 0) return;
    const img = a.images[idx];
    a.images = [img, ...a.images.filter((i) => i.id !== imageId)];
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
  }

  // ---------- tags ----------

  // 태그 정규화: 공백 제거, 앞에 # 보장.
  private static normalizeTag(tagInput: string): string {
    const tag = tagInput.trim().replace(/\s+/g, '');
    if (!tag) return '';
    return tag.startsWith('#') ? tag : `#${tag}`;
  }

  @action
  addTag(id: string, tag: string): void {
    const a = this.getArtist(id);
    if (!a) return;
    const t = ArtistLibraryService.normalizeTag(tag);
    if (!t || a.tags.includes(t)) return;
    a.tags = [...a.tags, t];
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
  }

  @action
  removeTag(id: string, tag: string): void {
    const a = this.getArtist(id);
    if (!a) return;
    a.tags = a.tags.filter((t) => t !== tag);
    a.updatedAt = Date.now();
    this.artists = [...this.artists];
    this.scheduleSave();
  }

  // ---------- tag presets ----------

  @action
  addTagPreset(tag: string): void {
    const t = ArtistLibraryService.normalizeTag(tag);
    if (!t || this.tagPresets.includes(t)) return;
    this.tagPresets = [...this.tagPresets, t];
    this.scheduleSave();
  }

  @action
  removeTagPreset(tag: string): void {
    this.tagPresets = this.tagPresets.filter((t) => t !== tag);
    this.scheduleSave();
  }

  // ---------- 백업 / 복원 ----------

  // 백업 tar에 담을 엔트리(라이브러리 JSON + 모든 작가 이미지) 목록.
  async buildBackupEntries(): Promise<{ path: string; name: string }[]> {
    const entries: { path: string; name: string }[] = [
      { path: ARTIST_LIBRARY_FILE, name: 'artist_library.json' },
    ];
    for (const a of this.artists) {
      for (const img of a.images) {
        if (await this.backend.existFile(img.path)) {
          // img.path = 'artist_library/<id>/<imgId>.png' — 그대로 보존
          entries.push({ path: img.path, name: img.path });
        }
      }
    }
    return entries;
  }

  // 압축 해제된 백업 폴더에서 작가를 병합 복원. 이름 충돌은 policy에 따라 처리.
  @action
  async restoreFromBackupDir(
    root: string,
    policy: 'rename' | 'skip' | 'overwrite',
  ): Promise<{ added: number; skipped: number; overwritten: number }> {
    let store: any;
    try {
      store = JSON.parse(
        await this.backend.readFile(`${root}/artist_library.json`),
      );
    } catch {
      throw new Error('백업에 작가 라이브러리 데이터가 없습니다');
    }
    const nextTags = this.tagPresets.slice();
    for (const tag of Array.isArray(store?.tagPresets)
      ? store.tagPresets
      : []) {
      if (typeof tag === 'string' && !nextTags.includes(tag))
        nextTags.push(tag);
    }
    const list = Array.isArray(store?.artists) ? store.artists : [];
    let nextArtists = this.artists.slice();
    const createdDirs = new Set<string>();
    const replacedDirs = new Set<string>();
    let added = 0;
    let skipped = 0;
    let overwritten = 0;
    try {
      for (const src of list) {
        if (!src || !src.name) continue;
        let name = src.name as string;
        const existing = nextArtists.find((a) => a.name === name);
        if (existing) {
          if (policy === 'skip') {
            skipped++;
            continue;
          }
          if (policy === 'overwrite') {
            nextArtists = nextArtists.filter((a) => a.id !== existing.id);
            replacedDirs.add(`${ARTIST_LIBRARY_DIR}/${existing.id}`);
            overwritten++;
          } else {
            const usedNames = new Set(nextArtists.map((a) => a.name));
            let i = 2;
            while (usedNames.has(name)) {
              name = `${src.name} (${i})`;
              i++;
            }
          }
        }
        const newId = uuidv4();
        const newImages: IArtistImage[] = [];
        const srcImages = Array.isArray(src.images) ? src.images : [];
        for (const img of srcImages) {
          if (!img || !img.path) continue;
          const srcPath = `${root}/${img.path}`;
          if (!(await this.backend.existFile(srcPath))) {
            throw new Error(`백업 작가 이미지가 없습니다: ${srcPath}`);
          }
          const imgId = uuidv4();
          const srcExt = img.path.split('.').pop() || 'png';
          const dir = `${ARTIST_LIBRARY_DIR}/${newId}`;
          const dest = `${dir}/${imgId}.${srcExt}`;
          createdDirs.add(dir);
          await this.backend.copyFile(srcPath, dest);
          const family: ModelSamplingFamily | undefined =
            img.family === 'v4_5' || img.family === 'v5'
              ? img.family
              : undefined;
          newImages.push(
            family
              ? { id: imgId, path: dest, family }
              : { id: imgId, path: dest },
          );
        }
        nextArtists.push({
          id: newId,
          name,
          images: newImages,
          tags: Array.isArray(src.tags)
            ? src.tags.filter((t: any) => typeof t === 'string')
            : [],
          favorite: !!src.favorite,
          createdAt: src.createdAt || Date.now(),
          updatedAt: Date.now(),
        });
        added++;
      }
      await this.flushSave(nextArtists, nextTags);
    } catch (error) {
      for (const dir of createdDirs) {
        try {
          await this.backend.deleteDir(dir);
        } catch (cleanupError) {
          console.warn('복원 중 생성된 작가 이미지 정리 실패:', cleanupError);
        }
      }
      throw error;
    }
    this.artists = nextArtists;
    this.tagPresets = nextTags;
    for (const dir of replacedDirs) {
      if (nextArtists.some((a) => `${ARTIST_LIBRARY_DIR}/${a.id}` === dir))
        continue;
      try {
        await this.backend.deleteDir(dir);
      } catch (error) {
        console.warn('교체된 작가 이미지 정리 실패:', error);
      }
    }
    return { added, skipped, overwritten };
  }

  // ---------- search ----------

  // 이름 또는 태그에 질의가 포함되는 작가만 반환.
  search(query: string): IArtistEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.artists;
    return this.artists.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }
}
