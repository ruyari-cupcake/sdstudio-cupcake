import type { Backend } from '../backend';
import type { TemplateService } from './TemplateService';
import type { SessionService } from './SessionService';
import type { ImageService } from './ImageService';
import { persistService } from './PersistenceService';
import {
  type GenericScene,
  type IInpaintScene,
  type IScene,
  type Session,
  genericSceneFromJSON,
} from './types';
import { isOutputImageFile, PNG_IMAGE_EXT } from './imageFormats';
import {
  projectPath,
  projectFolderPath,
  projectJsonPath,
  workspacePath,
  invalidProjectName,
  WORKSPACE_ROOT,
  PROJECT_JSON_ROOT,
  PROJECT_IMAGE_ROOTS,
  PROJECT_SCENE_MASK_ROOTS,
} from './projectPaths';
import type { ProjectImageRoot } from './projectPaths';
import {
  isWorkspaceLayout,
  physicalDirOf,
  nameOfPhysicalDir,
  registerProjectDir,
  unregisterProjectDir,
  type WorkspaceProjectMeta,
  PROJECT_META_FILE,
  PROJECT_JSON_FILE,
} from './storageLayout';
import {
  pickTrashSlotName,
  pickNewestTrashDir,
  sceneTrashBelongsTo,
  trashSlotCompareKey,
} from './trashList';

// 신 배치의 소프트 삭제 파일명(project.json.deleted).
export interface TrashServiceDependencies {
  readonly backend: Pick<
    Backend,
    | 'existFile'
    | 'readFile'
    | 'writeFile'
    | 'notifyGlobalStoreChanged'
    | 'renameFile'
    | 'listFiles'
    | 'deleteFile'
    | 'renameDir'
    | 'deleteDir'
    | 'listFilesWithStats'
  >;
  readonly templateService: Pick<TemplateService, 'removeProject'>;
  readonly sessionService: Pick<SessionService, 'guardCrossWindowLock'>;
  readonly imageService: Pick<ImageService, 'invalidateCacheBatch'>;
}

const WORKSPACE_DELETED_FILE = `${PROJECT_JSON_FILE}.deleted`;

// --- Type definitions ---

interface TrashImageMeta {
  [filename: string]: number; // filename -> deletedAt timestamp
}

// trash.json 호환 규칙(2026-10-02 S1·S2): 새 필드는 전부 선택 필드다. 구버전(5.4.0 이하)은
// 모르는 필드를 무시하고 키 `프로젝트:씬`·sceneData.name 으로만 동작하므로, 새 버전은
// 키의 씬 부분 = 휴지통 폴더 이름 = sceneData.name(= 슬롯 이름)을 항상 일치시킨다.
interface TrashSceneEntry {
  sceneData: IScene | IInpaintScene;
  deletedAt: number;
  // 원래 씬 이름 — 슬롯 이름이 원래 이름과 다를 때(「S (삭제 2)」)만 기록. 표시용.
  originalName?: string;
  // 신 배치 물리 폴더(이름__짧은id) — 같은 이름 프로젝트(휴지통의 옛 P 와 활성 P)의 씬
  // 기록을 구분한다. 없으면(구 배치·구버전 기록) 프로젝트 이름(키 접두)으로만 판정.
  projectDir?: string;
}

interface TrashProjectEntry {
  // 이 이름으로 가장 최근에 삭제된 시각(구버전이 읽는 값).
  deletedAt: number;
  // 신 배치: 휴지통 폴더별 삭제 시각(동명 공존). 없는 폴더는 deletedAt 으로 해석.
  dirs?: { [dir: string]: number };
}

interface TrashData {
  scenes: { [compositeKey: string]: TrashSceneEntry };
  projects: { [projectName: string]: TrashProjectEntry };
}

// 신 배치 workspace/ 1단 스캔 결과(폴더 1개).
interface WorkspaceScanEntry {
  name: string;
  dir: string;
  hasJson: boolean;
  hasDeleted: boolean;
}

/** 휴지통 프로젝트 1건. dir = 신 배치 물리 폴더(동명 구분용 내부 식별자 — 화면에 내지 않는다). */
export interface DeletedProjectInfo {
  name: string;
  deletedAt: number;
  dir?: string;
}

// --- Constants ---

const TRASH_FILE = 'trash.json';
const IMAGE_TRASH_DIR = '.trash';
const TRASH_META_FILE = '.trash_meta.json';

// 보존 기간(일) — 휴지통 안내 문구(TrashViews·만료 확인 창)가 이 값을 그대로 쓴다(단일 출처, S3).
export const IMAGE_RETENTION_DAYS = 3;
export const SCENE_RETENTION_DAYS = 14;
export const PROJECT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const IMAGE_RETENTION_MS = IMAGE_RETENTION_DAYS * DAY_MS;
const SCENE_RETENTION_MS = SCENE_RETENTION_DAYS * DAY_MS;
const PROJECT_RETENTION_MS = PROJECT_RETENTION_DAYS * DAY_MS;

// 변형 씬(구형) 마스크·원본 파일 이름 — inpaint_masks|inpaint_orgs/<프로젝트>/<씬>.png
function sceneMaskFileName(sceneName: string): string {
  return `${sceneName}.${PNG_IMAGE_EXT}`;
}

function isSceneMaskFileName(filename: string): boolean {
  return filename.toLowerCase().endsWith(`.${PNG_IMAGE_EXT}`);
}

// --- Service class ---

export class TrashService extends EventTarget {
  constructor(private readonly services: TrashServiceDependencies) {
    super();
  }

  private data: TrashData = { scenes: {}, projects: {} };

  private loaded: boolean = false;

  // Metadata snapshots and their file moves share one owner. A reload or a second
  // mutation must see the preceding committed snapshot, even after a failed task.
  private operationTail: Promise<void> = Promise.resolve();

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operationTail.then(operation);
    this.operationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  // ===== Core persistence =====

  async loadTrash(): Promise<void> {
    return this.serialize(() => this.loadTrashNow());
  }

  private async loadTrashNow(): Promise<void> {
    // A failed reload must revoke write access while retaining the last known data.
    this.loaded = false;
    try {
      let nextData: TrashData = { scenes: {}, projects: {} };
      if (await this.services.backend.existFile(TRASH_FILE)) {
        const parsed = JSON.parse(
          await this.services.backend.readFile(TRASH_FILE),
        );
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('휴지통 데이터 형식이 올바르지 않습니다');
        }
        for (const field of ['scenes', 'projects']) {
          const value = parsed[field];
          if (
            value !== undefined &&
            (!value || typeof value !== 'object' || Array.isArray(value))
          ) {
            throw new Error(`휴지통 ${field} 데이터 형식이 올바르지 않습니다`);
          }
        }
        nextData = {
          scenes: parsed.scenes ?? {},
          projects: parsed.projects ?? {},
        };
      }
      this.data = nextData;
      this.loaded = true;
    } catch (error) {
      console.error(
        'trash.json 로드 실패 — 기존 기록 보존 및 휴지통 쓰기 차단:',
        error,
      );
    }
  }

  private async commitTrash(nextData: TrashData): Promise<void> {
    this.ensureLoaded();
    await persistService.write(
      this.services.backend,
      TRASH_FILE,
      JSON.stringify(nextData),
    );
    this.data = nextData;
    this.dispatchEvent(new CustomEvent('trash-updated'));
    // The disk commit is complete; a broadcast failure must not roll back its files.
    this.services.backend.notifyGlobalStoreChanged('trash').catch((error) => {
      console.warn('휴지통 저장 후 다른 창 알림 실패:', error);
    });
  }

  async saveTrash(): Promise<void> {
    return this.serialize(() => this.saveTrashNow());
  }

  private async saveTrashNow(): Promise<void> {
    await this.commitTrash(this.data);
  }

  // 다른 창의 휴지통 변경 반영(W6 P2) — 디스크 재로드 + UI 갱신 이벤트.
  // loadTrash 의 IO 실패 차단 의미론(loaded 미설정)은 그대로 유지된다.
  async reloadExternal(): Promise<void> {
    return this.serialize(() => this.reloadExternalNow());
  }

  private async reloadExternalNow(): Promise<void> {
    await this.loadTrashNow();
    this.dispatchEvent(new CustomEvent('trash-updated'));
  }

  private ensureLoaded() {
    if (!this.loaded) throw new Error('TrashService not loaded');
  }

  // ===== Image trash =====

  private static getImageTrashDir(
    session: Session,
    scene: GenericScene,
  ): string {
    const base =
      scene.type === 'scene'
        ? projectPath('outs', session.name, scene.name)
        : projectPath('inpaints', session.name, scene.name);
    return `${base}/${IMAGE_TRASH_DIR}`;
  }

  private static getImageTrashMetaPath(
    session: Session,
    scene: GenericScene,
  ): string {
    return `${TrashService.getImageTrashDir(session, scene)}/${TRASH_META_FILE}`;
  }

  private async loadImageTrashMeta(
    session: Session,
    scene: GenericScene,
  ): Promise<TrashImageMeta> {
    const path = TrashService.getImageTrashMetaPath(session, scene);
    let raw: string;
    try {
      raw = await this.services.backend.readFile(path);
    } catch (error) {
      // Only confirmed absence represents an empty image trash; unreadable data is preserved.
      if (!(await this.services.backend.existFile(path))) return {};
      throw error;
    }
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.values(parsed).some(
        (value) => typeof value !== 'number' || !Number.isFinite(value),
      )
    ) {
      throw new Error(
        `이미지 휴지통 메타데이터 형식이 올바르지 않습니다: ${path}`,
      );
    }
    return parsed;
  }

  private async saveImageTrashMeta(
    session: Session,
    scene: GenericScene,
    meta: TrashImageMeta,
  ): Promise<void> {
    // writeFile auto-creates parent directories
    await persistService.write(
      this.services.backend,
      TrashService.getImageTrashMetaPath(session, scene),
      JSON.stringify(meta),
    );
  }

  // 반환값: 이동에 실패한 파일 수(잠금/권한 등). 호출부가 사용자에게 알릴 수 있도록
  // 조용히 삼키지 않고 집계해 돌려준다.
  async moveImagesToTrash(
    session: Session,
    scene: GenericScene,
    fullPaths: string[],
  ): Promise<number> {
    return this.serialize(() =>
      this.moveImagesToTrashNow(session, scene, fullPaths),
    );
  }

  private async moveImagesToTrashNow(
    session: Session,
    scene: GenericScene,
    fullPaths: string[],
  ): Promise<number> {
    const trashDir = TrashService.getImageTrashDir(session, scene);
    const meta = await this.loadImageTrashMeta(session, scene);
    const now = Date.now();

    // Ensure .trash directory exists by writing meta first
    // (writeFile auto-creates parent dirs)
    if (Object.keys(meta).length === 0 && fullPaths.length > 0) {
      await this.saveImageTrashMeta(session, scene, meta);
    }

    let failed = 0;
    for (const fullPath of fullPaths) {
      const filename = fullPath.split('/').pop()!;
      try {
        await this.services.backend.renameFile(
          fullPath,
          `${trashDir}/${filename}`,
        );
        meta[filename] = now;
      } catch (e) {
        failed++;
        console.error('이미지 휴지통 이동 실패:', fullPath, e);
      }
    }

    await this.saveImageTrashMeta(session, scene, meta);
    this.dispatchEvent(new CustomEvent('trash-updated'));
    return failed;
  }

  async getTrashImages(
    session: Session,
    scene: GenericScene,
  ): Promise<{ filename: string; deletedAt: number }[]> {
    return this.serialize(() => this.getTrashImagesNow(session, scene));
  }

  private async getTrashImagesNow(
    session: Session,
    scene: GenericScene,
  ): Promise<{ filename: string; deletedAt: number }[]> {
    const meta = await this.loadImageTrashMeta(session, scene);
    const trashDir = TrashService.getImageTrashDir(session, scene);
    let files: string[];
    try {
      files = await this.services.backend.listFiles(trashDir);
    } catch (error) {
      if (!(await this.services.backend.existFile(trashDir))) return [];
      throw error;
    }
    files = files.filter(isOutputImageFile);
    return files.map((f: string) => ({
      filename: f,
      deletedAt: meta[f] || 0,
    }));
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Keep the instance service API used by injected callers.
  getTrashImagePath(
    session: Session,
    scene: GenericScene,
    filename: string,
  ): string {
    return `${TrashService.getImageTrashDir(session, scene)}/${filename}`;
  }

  // 반환값: 복원에 실패한 파일 수. 실패 파일의 원본과 메타는 보존한다.
  async restoreImages(
    session: Session,
    scene: GenericScene,
    filenames: string[],
  ): Promise<number> {
    return this.serialize(() =>
      this.restoreImagesNow(session, scene, filenames),
    );
  }

  private async restoreImagesNow(
    session: Session,
    scene: GenericScene,
    filenames: string[],
  ): Promise<number> {
    const trashDir = TrashService.getImageTrashDir(session, scene);
    const outputDir =
      scene.type === 'scene'
        ? projectPath('outs', session.name, scene.name)
        : projectPath('inpaints', session.name, scene.name);
    const meta = await this.loadImageTrashMeta(session, scene);
    const restoredTrashPaths: string[] = [];
    let failed = 0;

    for (const filename of filenames) {
      try {
        const trashPath = `${trashDir}/${filename}`;
        await this.services.backend.renameFile(
          trashPath,
          `${outputDir}/${filename}`,
        );
        delete meta[filename];
        restoredTrashPaths.push(trashPath);
      } catch (e) {
        failed++;
        console.error('이미지 복원 실패:', filename, e);
      }
    }

    // 휴지통 썸네일은 디렉터리 단위로 한 번만 정리한다.
    try {
      await this.services.imageService.invalidateCacheBatch(restoredTrashPaths);
    } catch (error) {
      // Thumbnails are derived data; keep the completed file operation and its metadata.
      console.warn('휴지통 이미지 작업 후 썸네일 캐시 정리 실패:', error);
    }

    await this.saveImageTrashMeta(session, scene, meta);
    this.dispatchEvent(new CustomEvent('trash-updated'));
    return failed;
  }

  // onProgress: 일괄 작업 잠금(progressDialog)용 진행 통지 — 파일 1개 삭제마다 호출 (옵셔널=기존 호출 무변경)
  // 반환값: 삭제에 실패한 파일 수. 실패한 파일은 meta 항목을 보존해 자동 정리
  // (autoCleanup)가 다음에 재시도할 수 있게 한다 — 과거엔 실패해도 meta 를 지워
  // 해당 파일이 자동 삭제 대상에서 영구히 빠졌다(2026-07-26 webp 미삭제 버그).
  async permanentlyDeleteImages(
    session: Session,
    scene: GenericScene,
    filenames: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    return this.serialize(() =>
      this.permanentlyDeleteImagesNow(session, scene, filenames, onProgress),
    );
  }

  private async permanentlyDeleteImagesNow(
    session: Session,
    scene: GenericScene,
    filenames: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    const trashDir = TrashService.getImageTrashDir(session, scene);
    const meta = await this.loadImageTrashMeta(session, scene);

    let done = 0;
    let failed = 0;
    let lastProgressAt = 0;
    const removedPaths: string[] = [];
    for (const filename of filenames) {
      const trashPath = `${trashDir}/${filename}`;
      let removed = false;
      try {
        await this.services.backend.deleteFile(trashPath);
        removed = true;
      } catch (e) {
        // 이미 없는 파일(ENOENT)이면 정리된 것으로 간주. 확인 자체가 실패하면
        // 보수적으로 "아직 있음"으로 취급해 meta 를 보존한다.
        removed = !(await this.services.backend
          .existFile(trashPath)
          .catch(() => true));
        if (!removed) {
          failed++;
          console.error('이미지 영구 삭제 실패:', filename, e);
        }
      }
      if (removed) {
        delete meta[filename];
        removedPaths.push(trashPath);
      }
      done++;
      const now = Date.now();
      if (
        done === filenames.length ||
        done === 1 ||
        now - lastProgressAt >= 100
      ) {
        onProgress?.(done, filenames.length);
        lastProgressAt = now;
      }
    }

    // 파일별 3회 디스크 캐시 삭제 대신 .trash/fastcache를 한 번만 제거한다.
    try {
      await this.services.imageService.invalidateCacheBatch(removedPaths);
    } catch (error) {
      // Thumbnails are derived data; keep the completed file operation and its metadata.
      console.warn('휴지통 이미지 작업 후 썸네일 캐시 정리 실패:', error);
    }

    await this.saveImageTrashMeta(session, scene, meta);
    this.dispatchEvent(new CustomEvent('trash-updated'));
    return failed;
  }

  // 반환값: 삭제에 실패한 파일 수 (permanentlyDeleteImages 와 동일 의미)
  async emptyImageTrash(
    session: Session,
    scene: GenericScene,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    return this.serialize(() =>
      this.emptyImageTrashNow(session, scene, onProgress),
    );
  }

  private async emptyImageTrashNow(
    session: Session,
    scene: GenericScene,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    const items = await this.getTrashImagesNow(session, scene);
    if (items.length > 0) {
      return await this.permanentlyDeleteImagesNow(
        session,
        scene,
        items.map((i) => i.filename),
        onProgress,
      );
    }
    return 0;
  }

  // ===== Project-wide image trash (all active scenes) =====

  /**
   * 현재 프로젝트(세션)의 모든 활성 씬에 대해 이미지 휴지통 집계
   * 휴지통에 들어간 씬의 이미지는 포함하지 않음 (activeScenes만 순회)
   */
  async countProjectImageTrash(
    session: Session,
  ): Promise<{ totalImages: number; scenesWithTrash: number }> {
    return this.serialize(() => this.countProjectImageTrashNow(session));
  }

  private async countProjectImageTrashNow(
    session: Session,
  ): Promise<{ totalImages: number; scenesWithTrash: number }> {
    let totalImages = 0;
    let scenesWithTrash = 0;
    const allScenes: GenericScene[] = [
      ...session.getScenes('scene'),
      ...session.getScenes('inpaint'),
    ];
    for (const scene of allScenes) {
      const items = await this.getTrashImagesNow(session, scene);
      if (items.length > 0) {
        totalImages += items.length;
        scenesWithTrash += 1;
      }
    }
    return { totalImages, scenesWithTrash };
  }

  /**
   * 현재 프로젝트(세션)의 모든 활성 씬에 대해 이미지 휴지통을 영구 비움
   * 반환값: { deleted: 영구삭제된 이미지 수, failed: 삭제 실패 수 }
   */
  // onProgress: 일괄 작업 잠금(progressDialog)용 — 삭제 누계(이미지 단위)를 통지 (옵셔널=기존 호출 무변경)
  async emptyProjectImageTrash(
    session: Session,
    onProgress?: (deletedImages: number) => void,
  ): Promise<{ deleted: number; failed: number }> {
    return this.serialize(() =>
      this.emptyProjectImageTrashNow(session, onProgress),
    );
  }

  private async emptyProjectImageTrashNow(
    session: Session,
    onProgress?: (deletedImages: number) => void,
  ): Promise<{ deleted: number; failed: number }> {
    // 진행 통지(onProgress)는 "시도 누계" 기준 — 성공 누계를 오프셋으로 쓰면
    // 실패가 섞였을 때 다음 씬에서 진행바가 뒤로 갔다가 total 에 못 미친다.
    let attempted = 0;
    let deleted = 0;
    let failed = 0;
    const allScenes: GenericScene[] = [
      ...session.getScenes('scene'),
      ...session.getScenes('inpaint'),
    ];
    for (const scene of allScenes) {
      const items = await this.getTrashImagesNow(session, scene);
      if (items.length > 0) {
        const base = attempted;
        const f = await this.permanentlyDeleteImagesNow(
          session,
          scene,
          items.map((i) => i.filename),
          (done) => onProgress?.(base + done),
        );
        attempted += items.length;
        failed += f;
        deleted += items.length - f;
      }
    }
    return { deleted, failed };
  }

  // A missing path is harmless only when the backend confirms it after a failed delete.
  private async deleteTrashPath(
    path: string,
    directory: boolean,
  ): Promise<void> {
    try {
      if (directory) await this.services.backend.deleteDir(path);
      else await this.services.backend.deleteFile(path);
    } catch (error) {
      if (await this.services.backend.existFile(path)) throw error;
    }
  }

  private async moveTrashPath(
    from: string,
    to: string,
    directory: boolean,
    moved: { from: string; to: string; directory: boolean }[],
  ): Promise<void> {
    if (!(await this.services.backend.existFile(from))) return;
    if (await this.services.backend.existFile(to)) {
      throw new Error(`이동 대상이 이미 존재합니다: ${to}`);
    }
    try {
      if (directory) await this.services.backend.renameDir(from, to);
      else await this.services.backend.renameFile(from, to);
    } catch (error) {
      // Some backends can report an error after the source was fully moved.
      if (
        !(await this.services.backend.existFile(from)) &&
        (await this.services.backend.existFile(to))
      ) {
        moved.push({ from, to, directory });
      }
      throw error;
    }
    // Track the successful move before checking, so a verification I/O error also rolls it back.
    moved.push({ from, to, directory });
    if (await this.services.backend.existFile(from)) {
      moved.pop();
      throw new Error(
        `원래 경로가 남아 있어 이동을 확인할 수 없습니다: ${from} → ${to}`,
      );
    }
    if (!(await this.services.backend.existFile(to))) {
      moved.pop();
      throw new Error(`이동한 파일을 찾을 수 없습니다: ${to}`);
    }
  }

  private async rollbackTrashMoves(
    moved: { from: string; to: string; directory: boolean }[],
  ): Promise<string[]> {
    const stuck: string[] = [];
    for (const move of moved.slice().reverse()) {
      try {
        if (await this.services.backend.existFile(move.from)) {
          throw new Error(
            `되돌릴 경로에 다른 파일이 이미 있습니다: ${move.from}`,
          );
        }
        if (move.directory)
          await this.services.backend.renameDir(move.to, move.from);
        else await this.services.backend.renameFile(move.to, move.from);
        if (
          !(await this.services.backend.existFile(move.from)) ||
          (await this.services.backend.existFile(move.to))
        ) {
          throw new Error(`되돌리기 결과를 확인할 수 없습니다: ${move.to}`);
        }
      } catch (error) {
        stuck.push(move.to);
        console.error('휴지통 작업 실패 후 파일 복구 실패:', move.to, error);
      }
    }
    return stuck;
  }

  // ===== Scene trash =====

  private static sceneKey(projectName: string, sceneName: string): string {
    return `${projectName}:${sceneName}`;
  }

  async moveSceneToTrash(session: Session, scene: GenericScene): Promise<void> {
    return this.serialize(() => this.moveSceneToTrashNow(session, scene));
  }

  private async moveSceneToTrashNow(
    session: Session,
    scene: GenericScene,
  ): Promise<void> {
    if (
      !(await this.services.sessionService.guardCrossWindowLock(
        session.name,
        '씬 제거',
      ))
    )
      return;
    this.ensureLoaded();
    const fail = (reason: string) =>
      new Error(
        `씬 "${scene.name}"을(를) 휴지통으로 옮기지 못해 삭제하지 않았습니다. ${reason}`,
      );
    const imgDir = scene.type === 'scene' ? 'outs' : 'inpaints';
    const slot = await this.chooseSceneSlot(session, scene, fail);
    // Serialize before touching files, and publish the new record only after its disk commit.
    const entry: TrashSceneEntry = {
      sceneData: { ...(scene.toJSON() as IScene | IInpaintScene), name: slot },
      deletedAt: Date.now(),
    };
    if (slot !== scene.name) entry.originalName = scene.name;
    const projectDir = isWorkspaceLayout()
      ? physicalDirOf(session.name)
      : undefined;
    if (projectDir) entry.projectDir = projectDir;
    const moved: { from: string; to: string; directory: boolean }[] = [];
    try {
      if (scene.type === 'inpaint') {
        for (const root of PROJECT_SCENE_MASK_ROOTS) {
          const from = projectPath(
            root,
            session.name,
            sceneMaskFileName(scene.name),
          );
          if (await this.services.backend.existFile(from)) {
            await this.services.backend.writeFile(
              projectPath(root, session.name, IMAGE_TRASH_DIR, '.gitkeep'),
              '',
            );
            await this.moveTrashPath(
              from,
              projectPath(
                root,
                session.name,
                IMAGE_TRASH_DIR,
                sceneMaskFileName(slot),
              ),
              false,
              moved,
            );
          }
        }
      }
      const from = projectPath(imgDir, session.name, scene.name);
      if (await this.services.backend.existFile(from)) {
        await this.services.backend.writeFile(
          projectPath(imgDir, session.name, IMAGE_TRASH_DIR, '.gitkeep'),
          '',
        );
        await this.moveTrashPath(
          from,
          projectPath(imgDir, session.name, IMAGE_TRASH_DIR, slot),
          true,
          moved,
        );
      }
      await this.commitTrash({
        ...this.data,
        scenes: {
          ...this.data.scenes,
          [TrashService.sceneKey(session.name, slot)]: entry,
        },
      });
    } catch (error) {
      const stuck = await this.rollbackTrashMoves(moved);
      throw fail(
        `${error instanceof Error ? error.message : String(error)}${
          stuck.length ? ` 되돌리지 못한 파일: ${stuck.join(', ')}` : ''
        }`,
      );
    }
    session.removeScene(scene.type, scene.name);
  }

  // 휴지통 슬롯 이름 결정(S1). 이미 쓰인 이름 = 이 프로젝트 이름의 기록 키(종류·소속 무관 —
  // 키 유일성) + 다른 현재 씬 이름(복원 시 충돌 방지) + 대상 루트 .trash 안의 폴더/파일.
  // .trash 목록을 못 읽으면(부재는 [] 로 흡수됨) 판단할 수 없으므로 삭제를 중단한다.
  private async chooseSceneSlot(
    session: Session,
    scene: GenericScene,
    fail: (reason: string) => Error,
  ): Promise<string> {
    const taken: string[] = [];
    const prefix = `${session.name}:`;
    for (const key of Object.keys(this.data.scenes)) {
      if (key.startsWith(prefix)) taken.push(key.substring(prefix.length));
    }
    const selfKey = trashSlotCompareKey(scene.name);
    for (const s of [
      ...session.getScenes('scene'),
      ...session.getScenes('inpaint'),
    ]) {
      if (trashSlotCompareKey(s.name) !== selfKey) taken.push(s.name);
    }
    const roots: ProjectImageRoot[] =
      scene.type === 'scene'
        ? ['outs']
        : ['inpaints', ...PROJECT_SCENE_MASK_ROOTS];
    for (const root of roots) {
      let names: string[];
      try {
        names = await this.services.backend.listFiles(
          projectPath(root, session.name, IMAGE_TRASH_DIR),
        );
      } catch (e) {
        console.error('휴지통 폴더 목록 읽기 실패:', root, e);
        throw fail('휴지통 폴더를 확인하지 못했습니다.');
      }
      const isMaskRoot = (
        PROJECT_SCENE_MASK_ROOTS as readonly string[]
      ).includes(root);
      for (const n of names) {
        taken.push(n);
        if (isMaskRoot && isSceneMaskFileName(n)) {
          taken.push(n.slice(0, -(PNG_IMAGE_EXT.length + 1)));
        }
      }
    }
    return pickTrashSlotName(scene.name, taken);
  }

  // 씬 휴지통 기록의 파일 위치(.trash/…). 신 배치에서 기록의 projectDir 가 지금 그 이름으로
  // 등록된 폴더와 다르면(같은 이름의 다른 프로젝트 — 휴지통의 옛 프로젝트 등) 기록이 가리키는
  // 폴더를 직접 쓴다. 그 외에는 이름 관문(projectPath).
  private static sceneTrashPath(
    projectName: string,
    entry: TrashSceneEntry | undefined,
    root: ProjectImageRoot,
    leaf: string,
  ): string {
    if (
      isWorkspaceLayout() &&
      entry?.projectDir &&
      physicalDirOf(projectName) !== entry.projectDir
    ) {
      return workspacePath(entry.projectDir, root, IMAGE_TRASH_DIR, leaf);
    }
    return projectPath(root, projectName, IMAGE_TRASH_DIR, leaf);
  }

  // 이 프로젝트(지금 그 이름으로 열려 있는 것) 소속 기록인지. 구 배치는 이름만으로 판정.
  private static sceneEntryBelongs(
    projectName: string,
    entry: TrashSceneEntry,
  ): boolean {
    if (!isWorkspaceLayout()) return true;
    return sceneTrashBelongsTo(entry, physicalDirOf(projectName));
  }

  getDeletedScenes(projectName: string): {
    name: string;
    type: 'scene' | 'inpaint';
    deletedAt: number;
    originalName?: string;
  }[] {
    this.ensureLoaded();
    const prefix = `${projectName}:`;
    const result: {
      name: string;
      type: 'scene' | 'inpaint';
      deletedAt: number;
      originalName?: string;
    }[] = [];
    for (const [key, entry] of Object.entries(this.data.scenes)) {
      if (key.startsWith(prefix)) {
        if (!TrashService.sceneEntryBelongs(projectName, entry)) continue;
        const sceneName = key.substring(prefix.length);
        result.push({
          name: sceneName,
          type: entry.sceneData.type === 'inpaint' ? 'inpaint' : 'scene',
          deletedAt: entry.deletedAt,
          ...(typeof entry.originalName === 'string' && entry.originalName
            ? { originalName: entry.originalName }
            : {}),
        });
      }
    }
    return result;
  }

  async restoreScene(session: Session, sceneName: string): Promise<void> {
    return this.serialize(() => this.restoreSceneNow(session, sceneName));
  }

  private async restoreSceneNow(
    session: Session,
    sceneName: string,
  ): Promise<void> {
    this.ensureLoaded();
    const key = TrashService.sceneKey(session.name, sceneName);
    const entry = this.data.scenes[key];
    if (!entry) throw new Error('씬을 휴지통에서 찾을 수 없습니다');
    if (!TrashService.sceneEntryBelongs(session.name, entry)) {
      throw new Error(
        '이 씬은 같은 이름의 다른 프로젝트 휴지통 항목이라 여기서 복원할 수 없습니다',
      );
    }
    const sceneType = entry.sceneData.type === 'inpaint' ? 'inpaint' : 'scene';
    if (session.hasScene(sceneType, sceneName))
      throw new Error('같은 이름의 씬이 이미 존재합니다');
    // An invalid record must not move any files or create an empty active scene.
    const restoredScene = genericSceneFromJSON(entry.sceneData);
    if (!restoredScene)
      throw new Error(`씬 데이터를 복원할 수 없습니다: ${sceneName}`);
    restoredScene.name = sceneName;
    const imgDir = sceneType === 'scene' ? 'outs' : 'inpaints';
    const moved: { from: string; to: string; directory: boolean }[] = [];
    try {
      await this.moveTrashPath(
        projectPath(imgDir, session.name, IMAGE_TRASH_DIR, sceneName),
        projectPath(imgDir, session.name, sceneName),
        true,
        moved,
      );
      if (sceneType === 'inpaint') {
        for (const root of PROJECT_SCENE_MASK_ROOTS) {
          await this.moveTrashPath(
            projectPath(
              root,
              session.name,
              IMAGE_TRASH_DIR,
              sceneMaskFileName(sceneName),
            ),
            projectPath(root, session.name, sceneMaskFileName(sceneName)),
            false,
            moved,
          );
        }
      }
      const scenes = { ...this.data.scenes };
      delete scenes[key];
      await this.commitTrash({ ...this.data, scenes });
    } catch (error) {
      const stuck = await this.rollbackTrashMoves(moved);
      if (stuck.length) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} 되돌리지 못한 파일: ${stuck.join(', ')}`,
        );
      }
      throw error;
    }
    session.addScene(restoredScene);
  }

  async permanentlyDeleteScene(
    projectName: string,
    sceneName: string,
    sceneType: 'scene' | 'inpaint',
  ): Promise<void> {
    return this.serialize(() =>
      this.permanentlyDeleteSceneNow(projectName, sceneName, sceneType),
    );
  }

  private async permanentlyDeleteSceneNow(
    projectName: string,
    sceneName: string,
    sceneType: 'scene' | 'inpaint',
  ): Promise<void> {
    this.ensureLoaded();
    const key = TrashService.sceneKey(projectName, sceneName);
    const entry = this.data.scenes[key] as TrashSceneEntry | undefined;
    const imgDir = sceneType === 'scene' ? 'outs' : 'inpaints';
    await this.deleteTrashPath(
      TrashService.sceneTrashPath(projectName, entry, imgDir, sceneName),
      true,
    );
    if (sceneType === 'inpaint') {
      for (const root of PROJECT_SCENE_MASK_ROOTS) {
        await this.deleteTrashPath(
          TrashService.sceneTrashPath(
            projectName,
            entry,
            root,
            sceneMaskFileName(sceneName),
          ),
          false,
        );
      }
    }
    const scenes = { ...this.data.scenes };
    delete scenes[key];
    await this.commitTrash({ ...this.data, scenes });
  }

  // ===== Project trash =====

  // projects 루트 + 1단계 폴더 디렉터리 경로 목록.
  // (SessionService.getList 의 폴더 탐지 패턴과 동일: listFiles[파일+디렉토리] - listFilesWithStats[파일만] = 폴더)
  // 주의: listFiles/listFilesWithStats 는 폴더 부재(ENOENT)면 [] 를 반환하고,
  // 그 외(잠금/권한 등 EBUSY/EPERM)면 throw 한다. 과거엔 여기서 throw 를 삼켜
  // ['projects'] 로 격하했는데, 그러면 폴더 소속 프로젝트를 못 보고 "활성 없음"
  // 으로 오판해 활성 이미지가 삭제될 수 있었다. 이제 에러를 그대로 전파하고,
  // 파괴적 경로(permanentlyDeleteProject)가 "불확실하면 보존" 하도록 한다.
  private async getProjectDirs(): Promise<string[]> {
    const entries = await this.services.backend.listFiles(PROJECT_JSON_ROOT);
    const rootStats =
      await this.services.backend.listFilesWithStats(PROJECT_JSON_ROOT);
    const rootFileSet = new Set(rootStats.map((entry) => entry.name));
    const dirs = entries.filter(
      (e: string) => !rootFileSet.has(e) && !e.startsWith('.'),
    );
    return [PROJECT_JSON_ROOT, ...dirs.map((d) => projectFolderPath(d))];
  }

  // 신 배치(workspace/) 1단 스캔: 각 하위 폴더의 meta.json 을 읽어 논리 이름과
  // 활성/소프트삭제 상태를 함께 반환한다. 실제 IO 오류는 throw(구 배치 스캔과
  // 동일 계약 — 파괴적 경로가 "불확실하면 보존"). meta 파손도 오류로 전파한다.
  private async scanWorkspaceEntries(): Promise<
    { name: string; dir: string; hasJson: boolean; hasDeleted: boolean }[]
  > {
    const dirs = await this.services.backend.listFiles(WORKSPACE_ROOT); // ENOENT→[], 실오류→throw
    const result: {
      name: string;
      dir: string;
      hasJson: boolean;
      hasDeleted: boolean;
    }[] = [];
    for (const dir of dirs) {
      if (dir.startsWith('.')) continue;
      const metaPath = workspacePath(dir, PROJECT_META_FILE);
      if (!(await this.services.backend.existFile(metaPath))) continue;
      const meta: WorkspaceProjectMeta = JSON.parse(
        await this.services.backend.readFile(metaPath),
      );
      if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) {
        throw new Error(`프로젝트 정보를 확인할 수 없습니다: ${metaPath}`);
      }
      const hasJson = await this.services.backend.existFile(
        workspacePath(dir, PROJECT_JSON_FILE),
      );
      const hasDeleted = await this.services.backend.existFile(
        workspacePath(dir, WORKSPACE_DELETED_FILE),
      );
      result.push({ name: meta.name, dir, hasJson, hasDeleted });
    }
    return result;
  }

  // 주어진 확장자(.json / .deleted)를 가진 프로젝트 파일을 루트 + 폴더에서 모두 찾아
  // 이름 → 전체경로 맵으로 반환한다. (동명은 루트 우선)
  private async scanProjectFiles(suffix: string): Promise<Map<string, string>> {
    // 신 배치: workspace/ 하위의 project.json(활성)/project.json.deleted(소프트삭제)
    // 를 스캔한다. suffix 는 상태 선택자로만 쓰이고 경로는 신 배치 규칙으로 조립.
    if (isWorkspaceLayout()) {
      const map = new Map<string, string>();
      const wantDeleted = suffix === '.deleted';
      for (const e of await this.scanWorkspaceEntries()) {
        const want = wantDeleted ? e.hasDeleted : e.hasJson;
        if (!want) continue;
        if (!e.name.trim()) continue;
        if (map.has(e.name)) continue;
        map.set(
          e.name,
          wantDeleted
            ? workspacePath(e.dir, WORKSPACE_DELETED_FILE)
            : workspacePath(e.dir, PROJECT_JSON_FILE),
        );
      }
      return map;
    }
    const map = new Map<string, string>();
    const dirs = await this.getProjectDirs();
    for (const dir of dirs) {
      // ENOENT 는 [] 로 흡수되고, 실제 에러(잠금/권한)는 throw 된다.
      // 여기서 삼키면 활성 프로젝트를 "없음" 으로 오판 → 활성 이미지 오삭제 위험.
      const stats = await this.services.backend.listFilesWithStats(dir);
      for (const s of stats) {
        // '.deleted'/'.json' 처럼 이름 없이 확장자만 남은 점(.) 파일은
        // 프로젝트명 ''(빈 문자열)로 오인된다 — 빈 이름이 영구삭제로 흘러가면
        // outs 루트+빈 이름 = outs 루트 전체가 삭제된다(2026-07-06 실사고). 반드시 제외.
        if (s.name.startsWith('.')) continue;
        if (s.name.endsWith(suffix)) {
          const name = s.name.substring(0, s.name.length - suffix.length);
          if (!map.has(name)) map.set(name, `${dir}/${s.name}`);
        }
      }
    }
    return map;
  }

  // scanProjectFiles 와 독립적인 2차 가드: 활성 .json 이 실제로 존재하는지 직접 확인.
  // 루트(projects/<이름>.json)와 모든 폴더 경로를 점검한다.
  // getProjectDirs 가 throw 하면(스캔 불가) 호출부에서 "불확실 → 보존" 으로 처리한다.
  private async activeProjectFileExists(name: string): Promise<boolean> {
    // 신 배치: workspace/ 직접 스캔(레지스트리 비의존 — 소프트삭제로 미등록이어도
    // 활성 여부를 정확히 판정). scanWorkspaceEntries 는 실오류 시 throw → 호출부 보존.
    if (isWorkspaceLayout()) {
      for (const e of await this.scanWorkspaceEntries()) {
        if (e.name === name && e.hasJson) return true;
      }
      return false;
    }
    if (await this.services.backend.existFile(projectJsonPath(name)))
      return true;
    const dirs = await this.getProjectDirs();
    for (const dir of dirs) {
      if (dir === PROJECT_JSON_ROOT) continue;
      if (await this.services.backend.existFile(`${dir}/${name}.json`))
        return true;
    }
    return false;
  }

  // A failed scan must not be treated as an empty list: callers would discard its metadata.
  private async findAllDeletedPaths(name: string): Promise<string[]> {
    const result: string[] = [];
    if (isWorkspaceLayout()) {
      for (const entry of await this.scanWorkspaceEntries()) {
        if (entry.name === name && entry.hasDeleted) {
          result.push(workspacePath(entry.dir, WORKSPACE_DELETED_FILE));
        }
      }
      return result;
    }
    const target = `${name}.deleted`;
    for (const dir of await this.getProjectDirs()) {
      const stats = await this.services.backend.listFilesWithStats(dir);
      if (stats.some((entry) => entry.name === target))
        result.push(`${dir}/${target}`);
    }
    return result;
  }

  // 같은 이름의 기존 휴지통(.deleted) 항목을 모두 제거한다.
  // 동명 프로젝트를 재삭제하기 직전에 호출 → "최신 1개만 유지"를 보장하고
  // 플랫폼별 rename 덮어쓰기/오류 불확실성을 제거한다.
  // 이미지 디렉터리(outs/<이름> 등)는 이름 공유이므로 건드리지 않는다.
  // 신 배치는 고유 폴더(이름__id)로 동명 휴지통 항목이 공존하므로(2026-10-02 S2 사용자 결정)
  // 정리하지 않는다 — 구 배치 전용.
  async purgeDeletedProject(name: string): Promise<void> {
    return this.serialize(() => this.purgeDeletedProjectNow(name));
  }

  private async purgeDeletedProjectNow(name: string): Promise<void> {
    this.ensureLoaded();
    if (isWorkspaceLayout()) return;
    const paths = await this.findAllDeletedPaths(name);
    for (const path of paths) await this.deleteTrashPath(path, false);
    if (this.data.projects[name]) {
      const projects = { ...this.data.projects };
      delete projects[name];
      await this.commitTrash({ ...this.data, projects });
    }
  }

  // dir: 신 배치에서 방금 휴지통으로 옮긴 물리 폴더(SessionService.delete 가 삭제 전에 확보).
  // 폴더별 삭제 시각을 따로 남겨 동명 휴지통 항목을 구분한다(S2). deletedAt 은 구버전 호환용
  // 「이 이름의 가장 최근 삭제 시각」.
  async moveProjectToTrash(projectName: string, dir?: string): Promise<void> {
    return this.serialize(() => this.moveProjectToTrashNow(projectName, dir));
  }

  private async moveProjectToTrashNow(
    projectName: string,
    dir?: string,
  ): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();
    let entry: TrashProjectEntry = { deletedAt: now };
    if (isWorkspaceLayout() && dir) {
      const previous = this.data.projects[projectName];
      const dirs: { [dir: string]: number } = { ...(previous?.dirs ?? {}) };
      if (previous && !previous.dirs && previous.deletedAt > 0) {
        // A failed scan cannot safely replace the older per-project timestamps.
        for (const item of await this.scanWorkspaceEntries()) {
          if (
            item.name === projectName &&
            item.hasDeleted &&
            !item.hasJson &&
            item.dir !== dir &&
            !(item.dir in dirs)
          ) {
            dirs[item.dir] = previous.deletedAt;
          }
        }
      }
      dirs[dir] = now;
      entry = { deletedAt: now, dirs };
    }
    await this.commitTrash({
      ...this.data,
      projects: { ...this.data.projects, [projectName]: entry },
    });
  }

  // 휴지통 프로젝트 1개(폴더)의 삭제 시각. 폴더별 기록이 없으면 이름 단위 시각으로 해석.
  private projectDeletedAt(name: string, dir?: string): number {
    const rec = this.data.projects[name];
    if (!rec) return 0;
    const byDir = dir && rec.dirs ? rec.dirs[dir] : undefined;
    if (typeof byDir === 'number' && Number.isFinite(byDir)) return byDir;
    return rec.deletedAt || 0;
  }

  // 휴지통 프로젝트 기록에서 폴더 하나를 뺀다. remainingDirs = 그 뒤에도 휴지통에 남는 같은 이름 폴더.
  // 남는 폴더가 없으면 이름 기록 자체를 지운다. 반환: 변경 여부.
  private dropProjectRecord(
    name: string,
    dir: string | undefined,
    remainingDirs: string[],
    data: TrashData = this.data,
  ): boolean {
    const previous = data.projects[name];
    if (!previous) return false;
    if (remainingDirs.length === 0) {
      delete data.projects[name];
      return true;
    }
    const record: TrashProjectEntry = {
      ...previous,
      ...(previous.dirs ? { dirs: { ...previous.dirs } } : {}),
    };
    if (dir && record.dirs) delete record.dirs[dir];
    const times = remainingDirs
      .map((remainingDir) => record.dirs?.[remainingDir])
      .filter(
        (time): time is number =>
          typeof time === 'number' && Number.isFinite(time),
      );
    if (times.length > 0) record.deletedAt = Math.max(...times);
    data.projects[name] = record;
    return true;
  }

  // 씬 휴지통 기록을 한 프로젝트 이름에서 다른 이름으로 옮긴다(신 배치에서만 projectDir 로 소속 확인).
  // 옮길 키가 이미 다른 기록(같은 이름의 다른 프로젝트)에 쓰이고 있으면 슬롯을 새로 정해
  // 휴지통 폴더·마스크 파일 이름도 함께 바꾼다(키 유일성 — 덮어쓰기 금지). 폴더 이름을 못 바꾸면
  // 그 기록은 옛 키에 그대로 둔다(기록·파일 보존, 목록에서만 안 보임 — 자동 정리는 projectDir 로 찾아간다).
  // 호출 전에 newName 이 이 프로젝트 폴더로 등록돼 있어야 한다(신 배치). 반환: 변경 여부.
  private async moveSceneKeys(
    oldName: string,
    newName: string,
    belongs: (entry: TrashSceneEntry) => boolean,
  ): Promise<boolean> {
    let changed = false;
    const prefix = `${oldName}:`;
    const newPrefix = `${newName}:`;
    for (const key of Object.keys(this.data.scenes)) {
      if (!key.startsWith(prefix)) continue;
      const entry = this.data.scenes[key];
      if (!entry || !belongs(entry)) continue;
      const sceneName = key.substring(prefix.length);
      let slot = sceneName;
      if (this.data.scenes[newPrefix + slot] && newPrefix + slot !== key) {
        if (!isWorkspaceLayout()) {
          // 구 배치: 예전 동작 유지(덮어씀) — 이미지 폴더를 이름으로 공유하는 배치라 충돌 해소 대상 아님.
        } else {
          const reslotted = await this.reslotSceneEntry(
            newName,
            entry,
            sceneName,
          );
          if (!reslotted) continue;
          slot = reslotted;
        }
      }
      this.data.scenes[newPrefix + slot] = entry;
      delete this.data.scenes[key];
      changed = true;
    }
    return changed;
  }

  // moveSceneKeys 의 충돌 해소: newName 프로젝트(이 기록의 폴더)의 .trash 안에서 빈 슬롯을 골라
  // 폴더·마스크 파일을 그 이름으로 옮기고 기록을 갱신한다. 실패하면 undefined(무변경).
  private async reslotSceneEntry(
    projectName: string,
    entry: TrashSceneEntry,
    slot: string,
  ): Promise<string | undefined> {
    const moved: { from: string; to: string; directory: boolean }[] = [];
    try {
      const isInpaint = entry.sceneData.type === 'inpaint';
      const imgDir: ProjectImageRoot = isInpaint ? 'inpaints' : 'outs';
      const taken: string[] = [];
      const prefix = `${projectName}:`;
      for (const k of Object.keys(this.data.scenes)) {
        if (k.startsWith(prefix)) taken.push(k.substring(prefix.length));
      }
      const roots: ProjectImageRoot[] = isInpaint
        ? [imgDir, ...PROJECT_SCENE_MASK_ROOTS]
        : [imgDir];
      for (const root of roots) {
        const names = await this.services.backend.listFiles(
          projectPath(root, projectName, IMAGE_TRASH_DIR),
        );
        for (const n of names) {
          taken.push(n);
          if (root !== imgDir && isSceneMaskFileName(n)) {
            taken.push(n.slice(0, -(PNG_IMAGE_EXT.length + 1)));
          }
        }
      }
      const next = pickTrashSlotName(slot, taken);
      const src = projectPath(imgDir, projectName, IMAGE_TRASH_DIR, slot);
      await this.moveTrashPath(
        src,
        projectPath(imgDir, projectName, IMAGE_TRASH_DIR, next),
        true,
        moved,
      );

      if (isInpaint) {
        for (const root of PROJECT_SCENE_MASK_ROOTS) {
          const m = projectPath(
            root,
            projectName,
            IMAGE_TRASH_DIR,
            sceneMaskFileName(slot),
          );
          await this.moveTrashPath(
            m,
            projectPath(
              root,
              projectName,
              IMAGE_TRASH_DIR,
              sceneMaskFileName(next),
            ),
            false,
            moved,
          );
        }
      }
      if (!entry.originalName)
        entry.originalName = entry.sceneData.name || slot;
      entry.sceneData = { ...entry.sceneData, name: next } as
        | IScene
        | IInpaintScene;
      return next;
    } catch (error) {
      const stuck = await this.rollbackTrashMoves(moved);
      console.error(
        '휴지통 씬 기록 이관 중 슬롯 변경 실패 — 옛 키 유지:',
        slot,
        error,
      );
      if (stuck.length) {
        throw new Error(
          `휴지통 씬 이름 변경 후 되돌리지 못한 파일: ${stuck.join(', ')}`,
        );
      }
      return undefined;
    }
  }

  // 프로젝트 이름변경 시 trash.json 의 키를 새 이름으로 이관한다.
  // 씬 휴지통 복원은 '<프로젝트>:<씬>' 복합 키 + outs/<프로젝트>/.trash 경로에
  // 의존하는데, 이미지 디렉터리는 rename 시 새 이름으로 이동하므로 키를 함께
  // 옮기지 않으면 기존 삭제 씬이 복원 불가한 유령이 된다.
  // 로드 실패 상태(!loaded)에서는 저장 자체가 기존 기록을 지울 수 있으므로
  // 이관을 조용히 건너뛴다 (rename 본체를 막지 않음 — loadTrash 주석 참조).
  // 신 배치(S2): 이름이 바뀐 활성 프로젝트 소속(projectDir 일치 또는 기록 없음) 씬 기록만 옮기고,
  // 휴지통 프로젝트 기록(projects[oldName])은 휴지통에 남은 같은 이름 폴더의 것이라 옮기지 않는다.
  async renameProjectKeys(oldName: string, newName: string): Promise<void> {
    return this.serialize(() => this.renameProjectKeysNow(oldName, newName));
  }

  private async renameProjectKeysNow(
    oldName: string,
    newName: string,
  ): Promise<void> {
    if (!this.loaded) {
      console.error('trash.json 미로드 — 이름변경 키 이관 건너뜀:', oldName);
      return;
    }
    if (isWorkspaceLayout()) {
      const dir = physicalDirOf(newName);
      const changed = await this.moveSceneKeys(oldName, newName, (entry) =>
        sceneTrashBelongsTo(entry, dir),
      );
      if (changed) await this.saveTrashNow();
      return;
    }
    let changed = await this.moveSceneKeys(oldName, newName, () => true);
    if (this.data.projects[oldName]) {
      this.data.projects[newName] = this.data.projects[oldName];
      delete this.data.projects[oldName];
      changed = true;
    }
    if (changed) await this.saveTrashNow();
  }

  // 신 배치 휴지통 프로젝트 목록(폴더 단위). 같은 폴더에 활성 project.json 이 함께 있는 비정상
  // 상태는 휴지통으로 보지 않는다(복원 대상 아님). 스캔 실오류는 throw.
  private async workspaceTrashEntries(): Promise<
    { name: string; dir: string; deletedAt: number }[]
  > {
    const result: { name: string; dir: string; deletedAt: number }[] = [];
    for (const e of await this.scanWorkspaceEntries()) {
      if (!e.hasDeleted || e.hasJson) continue;
      if (!e.name.trim()) continue;
      result.push({
        name: e.name,
        dir: e.dir,
        deletedAt: this.projectDeletedAt(e.name, e.dir),
      });
    }
    return result;
  }

  async getDeletedProjects(): Promise<DeletedProjectInfo[]> {
    return this.serialize(() => this.getDeletedProjectsNow());
  }

  private async getDeletedProjectsNow(): Promise<DeletedProjectInfo[]> {
    this.ensureLoaded();
    // 신 배치(S2): 고유 폴더 단위로 전부 돌려준다 — 같은 이름의 활성 프로젝트가 있어도 숨기지 않는다.
    if (isWorkspaceLayout()) {
      return await this.workspaceTrashEntries();
    }
    // 루트 + 폴더 하위까지 .deleted / .json 을 모두 스캔 (폴더 소속 프로젝트 포함)
    const deletedMap = await this.scanProjectFiles('.deleted');
    const activeMap = await this.scanProjectFiles('.json');

    const result: { name: string; deletedAt: number }[] = [];
    for (const name of deletedMap.keys()) {
      // 동명의 활성 .json 이 있으면 orphan 이므로 제외
      if (activeMap.has(name)) continue;
      // 빈/공백 이름은 목록에 올리지 않는다 (영구삭제 유도 방지 — 스캔 단계
      // 점 파일 제외와 이중 방어)
      if (!name.trim()) continue;
      result.push({
        name,
        deletedAt: this.data.projects[name]?.deletedAt || 0,
      });
    }
    return result;
  }

  // 신 배치에서 .deleted 를 지운 폴더에 남는 project.json.bak(쓰기 회전 잔해)도
  // 함께 지운다 — 남겨두면 "본문·삭제본 없음+.bak 있음" 상태가 되어 스캔의
  // .bak 자가치유가 삭제된 프로젝트를 부활시킨다.
  private async deleteWorkspaceBakSibling(deletedPath: string): Promise<void> {
    if (!isWorkspaceLayout()) return;
    if (!deletedPath.endsWith(WORKSPACE_DELETED_FILE)) return;
    const bakPath = `${deletedPath.slice(0, -'.deleted'.length)}.bak`;
    await this.deleteTrashPath(bakPath, false);
  }

  // opts.dir: 신 배치에서 복원할 휴지통 폴더(동명 구분). 없으면 같은 이름 중 가장 최근 삭제분.
  // opts.newName: 같은 이름의 활성 프로젝트가 있을 때 쓸 새 이름(신 배치 전용 — 구 배치는 무시).
  async restoreProject(
    name: string,
    opts?: { dir?: string; newName?: string },
  ): Promise<void> {
    return this.serialize(() => this.restoreProjectNow(name, opts));
  }

  private async restoreProjectNow(
    name: string,
    opts?: { dir?: string; newName?: string },
  ): Promise<void> {
    this.ensureLoaded();
    if (isWorkspaceLayout()) {
      await this.restoreWorkspaceProject(name, opts);
      return;
    }
    const deletedMap = await this.scanProjectFiles('.deleted');
    const activeMap = await this.scanProjectFiles('.json');
    const deletedPath = deletedMap.get(name);

    if (activeMap.has(name)) {
      // Orphan .deleted: 활성 프로젝트가 있으니 .deleted 만 제거(구 배치 — 이미지 폴더를
      // 이름으로 공유해 동명 공존 불가)
      if (deletedPath) {
        await this.deleteTrashPath(deletedPath, false);
        await this.deleteWorkspaceBakSibling(deletedPath);
      }
    } else if (deletedPath) {
      // 같은 위치(폴더 포함)에 .json 으로 되돌린다 → 폴더 소속도 복원됨
      const jsonPath = deletedPath.replace(/\.deleted$/, '.json');
      await this.services.backend.renameFile(deletedPath, jsonPath);
    } else {
      throw new Error('프로젝트를 휴지통에서 찾을 수 없습니다');
    }
    delete this.data.projects[name];
    await this.saveTrashNow();
  }

  // 신 배치 복원(S2): project.json.deleted → project.json (접미 제거). 물리 폴더는 불변이라
  // 폴더 소속(meta.folder)도 그대로 복원된다. 같은 이름의 활성 프로젝트가 있으면 새 이름이
  // 있어야 하고, 그 경우 활성화 전에 meta.json 의 이름을 먼저 바꾼다(스캔·레지스트리는
  // meta.name 이 진실 — 본문 name 은 불러올 때 onAttached 가 맞춘다). 예전처럼 활성 동명이
  // 있다고 휴지통 쪽 .deleted 를 지우지 않는다.
  private async restoreWorkspaceProject(
    name: string,
    opts?: { dir?: string; newName?: string },
  ): Promise<void> {
    const trashed = (await this.workspaceTrashEntries()).filter(
      (e) => e.name === name,
    );
    const targetDir = opts?.dir
      ? trashed.find((e) => e.dir === opts.dir)?.dir
      : pickNewestTrashDir(trashed);
    if (!targetDir) throw new Error('프로젝트를 휴지통에서 찾을 수 없습니다');

    const finalName = opts?.newName !== undefined ? opts.newName : name;
    const reason = invalidProjectName(finalName);
    if (reason)
      throw new Error(`사용할 수 없는 프로젝트 이름입니다(${reason}).`);
    if (
      physicalDirOf(finalName) !== undefined ||
      (await this.activeProjectFileExists(finalName))
    ) {
      throw new Error(
        finalName === name
          ? `같은 이름의 프로젝트 "${name}"이(가) 이미 있습니다. 새 이름으로 복원해 주세요.`
          : `이미 존재하는 프로젝트 이름입니다: ${finalName}`,
      );
    }

    const deletedPath = workspacePath(targetDir, WORKSPACE_DELETED_FILE);
    const jsonPath = workspacePath(targetDir, PROJECT_JSON_FILE);
    const metaPath = workspacePath(targetDir, PROJECT_META_FILE);
    let prevMetaRaw: string | undefined;
    if (finalName !== name) {
      let meta: WorkspaceProjectMeta | undefined;
      try {
        prevMetaRaw = await this.services.backend.readFile(metaPath);
        meta = JSON.parse(prevMetaRaw);
      } catch {
        meta = undefined;
      }
      if (!meta || typeof meta !== 'object') {
        throw new Error(
          '프로젝트 정보(meta.json)를 읽지 못해 새 이름으로 복원하지 않았습니다.',
        );
      }
      await this.services.backend.writeFile(
        metaPath,
        JSON.stringify({ ...meta, name: finalName }),
      );
    }
    try {
      await this.services.backend.renameFile(deletedPath, jsonPath);
    } catch (e) {
      // 활성화 실패 — 바꿔 둔 meta 이름을 되돌린다(휴지통 항목 그대로 유지).
      if (prevMetaRaw !== undefined) {
        try {
          await this.services.backend.writeFile(metaPath, prevMetaRaw);
        } catch (rollbackError) {
          console.error(
            '프로젝트 복원 실패 후 원래 이름 복구 실패:',
            metaPath,
            rollbackError,
          );
          throw new Error(
            `프로젝트 복원 및 원래 이름 복구에 실패했습니다: ${metaPath}`,
          );
        }
      }
      throw e;
    }
    registerProjectDir(finalName, targetDir);

    // 휴지통 기록 정리: 이 폴더 소속 씬 기록을 새 이름으로, 프로젝트 기록에서 이 폴더 제외.
    if (finalName !== name) {
      await this.moveSceneKeys(
        name,
        finalName,
        (entry) => entry.projectDir === targetDir,
      );
    }
    this.dropProjectRecord(
      name,
      targetDir,
      trashed.filter((e) => e.dir !== targetDir).map((e) => e.dir),
    );
    await this.saveTrashNow();
  }

  // 신 배치 영구 삭제(S2): 대상은 휴지통 폴더 하나(dir, 없으면 같은 이름 중 가장 최근 삭제분).
  // 같은 이름의 활성 프로젝트는 다른 폴더라 건드리지 않는다 — 대상 폴더 자체가 활성(본문 있음·
  // 레지스트리 등록)이면 아무것도 지우지 않는다. 스캔이 실패하면 아무것도 바꾸지 않는다.
  private async permanentlyDeleteWorkspaceProject(
    name: string,
    dir?: string,
  ): Promise<void> {
    let entries: WorkspaceScanEntry[];
    try {
      entries = await this.scanWorkspaceEntries();
    } catch (error) {
      console.error(
        '프로젝트 영구 삭제: 스캔 실패 — 아무것도 지우지 않음:',
        name,
        error,
      );
      throw error;
    }
    const activeSameName = entries.some((e) => e.name === name && e.hasJson);
    const trashed = entries
      .filter((e) => e.name === name && e.hasDeleted && !e.hasJson)
      .map((e) => ({
        dir: e.dir,
        deletedAt: this.projectDeletedAt(name, e.dir),
      }));
    const targetDir = dir
      ? trashed.find((t) => t.dir === dir)?.dir
      : pickNewestTrashDir(trashed);
    const remaining = trashed
      .filter((t) => t.dir !== targetDir)
      .map((t) => t.dir);

    if (targetDir) {
      const registered = nameOfPhysicalDir(targetDir) !== undefined;
      const jsonExists = await this.services.backend.existFile(
        workspacePath(targetDir, PROJECT_JSON_FILE),
      );
      if (registered || jsonExists) {
        console.error(
          '프로젝트 영구 삭제 거부 — 대상 폴더가 활성 상태:',
          targetDir,
        );
        return;
      }
      // A recursive delete may remove discovery files before failing on an image.
      // Capture their exact bytes first so the remaining trash stays visible for retry.
      const discoveryFiles = await Promise.all(
        [PROJECT_META_FILE, WORKSPACE_DELETED_FILE].map(async (file) => {
          const path = workspacePath(targetDir, file);
          return { path, contents: await this.services.backend.readFile(path) };
        }),
      );
      try {
        await this.deleteTrashPath(workspacePath(targetDir), true);
      } catch (error) {
        const restoreFailures: string[] = [];
        for (const file of discoveryFiles) {
          try {
            // Another window may have recovered a newer marker: retain that value.
            if (!(await this.services.backend.existFile(file.path))) {
              await this.services.backend.writeFile(file.path, file.contents);
            }
          } catch (restoreError) {
            restoreFailures.push(file.path);
            console.error(
              '휴지통 일부 삭제 후 발견 정보 복구 실패:',
              file.path,
              restoreError,
            );
          }
        }
        if (restoreFailures.length) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} 복구하지 못한 휴지통 정보: ${restoreFailures.join(', ')}`,
          );
        }
        throw error;
      }
      if (physicalDirOf(name) === targetDir) unregisterProjectDir(name);
    }

    // 기록 정리: 이 폴더 소속 씬 기록. 소속 기록이 없는 옛 씬 기록(이름만)은 같은 이름의
    // 활성 프로젝트도 남은 휴지통 폴더도 없을 때만 지운다(누구 것인지 모르므로 보존 우선).
    const lastOfName = !activeSameName && remaining.length === 0;
    const nextData: TrashData = {
      scenes: { ...this.data.scenes },
      projects: { ...this.data.projects },
    };
    const prefix = `${name}:`;
    for (const key of Object.keys(nextData.scenes)) {
      if (!key.startsWith(prefix)) continue;
      const entry = nextData.scenes[key];
      const owned = entry?.projectDir
        ? targetDir !== undefined && entry.projectDir === targetDir
        : lastOfName;
      if (owned) delete nextData.scenes[key];
    }
    // Failed template cleanup stays retryable; active same-name projects retain their setting.
    if (lastOfName) await this.services.templateService.removeProject(name);
    this.dropProjectRecord(name, targetDir ?? dir, remaining, nextData);
    await this.commitTrash(nextData);
  }

  // dir: 신 배치에서 영구 삭제할 휴지통 폴더(동명 구분). 없으면 같은 이름 중 가장 최근 삭제분
  // (전체 백업 덮어쓰기처럼 방금 delete 한 프로젝트를 이름으로 지우는 호출부 호환).
  async permanentlyDeleteProject(name: string, dir?: string): Promise<void> {
    return this.serialize(() => this.permanentlyDeleteProjectNow(name, dir));
  }

  private async permanentlyDeleteProjectNow(
    name: string,
    dir?: string,
  ): Promise<void> {
    this.ensureLoaded();

    // CRITICAL: 빈/공백 이름이나 경로 문자가 섞인 이름은 이미지 디렉터리 경로가
    // 'outs/' 처럼 데이터 루트 자체 또는 다른 위치가 되어 대량 오삭제로 이어진다
    // (2026-07-06 outs 전체 증발 실사고). 파일시스템은 건드리지 않고
    // 휴지통 기록의 유령 항목만 정리한 뒤 즉시 중단한다.
    if (
      !name ||
      !name.trim() ||
      name.includes('/') ||
      name.includes('\\') ||
      name.includes('..')
    ) {
      console.error(
        '프로젝트 영구 삭제 거부 — 유효하지 않은 이름:',
        JSON.stringify(name),
      );
      if (name in this.data.projects) {
        delete this.data.projects[name];
        await this.saveTrashNow();
      }
      return;
    }

    // 신 배치: 고유 폴더 단위 영구 삭제(S2 — 동명 공존).
    if (isWorkspaceLayout()) {
      await this.permanentlyDeleteWorkspaceProject(name, dir);
      return;
    }

    // Legacy projects share image directories by name. Resolve every active/deleted
    // location before touching files, and leave all records intact on uncertain scans.
    const deletedPaths = await this.findAllDeletedPaths(name);
    const activeMap = await this.scanProjectFiles('.json');
    const activeExists =
      activeMap.has(name) || (await this.activeProjectFileExists(name));
    if (!activeExists) {
      for (const root of PROJECT_IMAGE_ROOTS) {
        await this.deleteTrashPath(projectPath(root, name), true);
      }
    }
    // Keep the deletion marker discoverable until all owned image directories are gone.
    for (const path of deletedPaths) await this.deleteTrashPath(path, false);
    const nextData: TrashData = {
      scenes: { ...this.data.scenes },
      projects: { ...this.data.projects },
    };
    if (!activeExists) {
      const prefix = `${name}:`;
      for (const key of Object.keys(nextData.scenes)) {
        if (key.startsWith(prefix)) delete nextData.scenes[key];
      }
      await this.services.templateService.removeProject(name);
    }
    delete nextData.projects[name];
    await this.commitTrash(nextData);
  }

  // ===== Expired project management =====

  async getExpiredProjects(): Promise<DeletedProjectInfo[]> {
    return this.serialize(() => this.getExpiredProjectsNow());
  }

  private async getExpiredProjectsNow(): Promise<DeletedProjectInfo[]> {
    this.ensureLoaded();
    const now = Date.now();
    // 스캔 실패 시(폴더 잠금/권한/동기화 등) 만료 목록을 비워 시작을 막지 않고,
    // 불확실한 상태에서 만료 다이얼로그를 띄워 삭제를 유도하지 않는다.
    let deleted: DeletedProjectInfo[];
    try {
      deleted = await this.getDeletedProjectsNow();
    } catch (e) {
      console.error('만료 프로젝트 조회 실패 — 이번 실행은 건너뜀:', e);
      return [];
    }
    return deleted.filter((p) => now - p.deletedAt >= PROJECT_RETENTION_MS);
  }

  // 만료 확인 창의 「미루기」. 항목은 이름(구 배치·예전 호출) 또는 {이름, 폴더}(신 배치 동명 구분).
  async deferProjects(
    items: (string | { name: string; dir?: string })[],
  ): Promise<void> {
    return this.serialize(() => this.deferProjectsNow(items));
  }

  private async deferProjectsNow(
    items: (string | { name: string; dir?: string })[],
  ): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();
    for (const item of items) {
      const name = typeof item === 'string' ? item : item.name;
      const dir = typeof item === 'string' ? undefined : item.dir;
      const rec = this.data.projects[name];
      if (!rec) {
        // 신 배치에서 기록이 없던 폴더(구버전이 지운 기록 등)는 새로 만들어 둔다 — 없으면 시각
        // 0 으로 해석돼 미뤄도 매번 만료로 다시 뜬다.
        if (isWorkspaceLayout() && dir) {
          this.data.projects[name] = { deletedAt: now, dirs: { [dir]: now } };
        }
        continue;
      }
      rec.deletedAt = now;
      if (isWorkspaceLayout()) {
        if (dir) {
          rec.dirs = { ...(rec.dirs ?? {}), [dir]: now };
        } else if (rec.dirs) {
          for (const d of Object.keys(rec.dirs)) rec.dirs[d] = now;
        }
      }
    }
    if (items.length > 0) {
      await this.saveTrashNow();
    }
  }

  // ===== Auto-cleanup =====

  async autoCleanup(): Promise<void> {
    return this.serialize(() => this.autoCleanupNow());
  }

  private async autoCleanupNow(): Promise<void> {
    this.ensureLoaded();
    const now = Date.now();

    // 0. Silently clean orphan .deleted files (where .json also exists) — 폴더 포함
    //    구 배치 전용(S2): 신 배치는 같은 이름의 활성 프로젝트와 휴지통 항목이 다른 폴더로
    //    공존하므로 「동명 활성 존재 = 고아」가 아니다 — 지우면 휴지통 항목이 사라진다.
    if (!isWorkspaceLayout()) {
      try {
        const deletedMap = await this.scanProjectFiles('.deleted');
        const activeMap = await this.scanProjectFiles('.json');
        let changed = false;
        for (const [name, path] of deletedMap) {
          if (activeMap.has(name)) {
            await this.deleteTrashPath(path, false);
            await this.deleteWorkspaceBakSibling(path);
            delete this.data.projects[name];
            changed = true;
          }
        }
        if (changed) {
          await this.saveTrashNow();
        }
      } catch (error) {
        // Background cleanup is retried later; a failed delete retains its record.
        console.warn(
          '휴지통 자동 정리: 이전 삭제 표시 정리를 건너뜁니다:',
          error,
        );
      }
    }

    // 1. Project cleanup is now handled by ExpiredProjectsDialog (user confirmation required)
    //    See getExpiredProjects() and deferProjects()

    // 2. Cleanup expired scenes (14 days)
    const sceneKeys = Object.keys(this.data.scenes);
    for (const key of sceneKeys) {
      const entry = this.data.scenes[key];
      if (!entry) continue;
      const age = now - entry.deletedAt;
      if (age >= SCENE_RETENTION_MS) {
        const [projectName, sceneName] = [
          key.substring(0, key.indexOf(':')),
          key.substring(key.indexOf(':') + 1),
        ];
        const sceneType =
          entry.sceneData.type === 'inpaint' ? 'inpaint' : 'scene';
        await this.permanentlyDeleteSceneNow(
          projectName,
          sceneName,
          sceneType as 'scene' | 'inpaint',
        );
      }
    }

    // 3. Cleanup expired images (3 days) — 폴더 소속 프로젝트 포함
    let activeProjects: string[];
    try {
      activeProjects = Array.from(
        (await this.scanProjectFiles('.json')).keys(),
      );
    } catch (error) {
      // Optional startup cleanup must not infer that an unreadable project is absent.
      console.warn(
        '휴지통 자동 정리: 활성 프로젝트 조회 실패로 건너뜁니다:',
        error,
      );
      return;
    }

    for (const projectName of activeProjects) {
      for (const imgDir of ['outs', 'inpaints'] as const) {
        let sceneDirs: string[];
        try {
          sceneDirs = await this.services.backend.listFiles(
            projectPath(imgDir, projectName),
          );
        } catch (error) {
          console.warn(
            '휴지통 자동 정리: 씬 목록을 읽지 못해 건너뜁니다:',
            projectName,
            error,
          );
          continue;
        }
        for (const sceneDir of sceneDirs) {
          if (sceneDir === IMAGE_TRASH_DIR || sceneDir.startsWith('.'))
            continue;
          const trashMetaPath = projectPath(
            imgDir,
            projectName,
            sceneDir,
            IMAGE_TRASH_DIR,
            TRASH_META_FILE,
          );
          if (!(await this.services.backend.existFile(trashMetaPath))) continue;
          try {
            const metaStr = await this.services.backend.readFile(trashMetaPath);
            const meta: TrashImageMeta = JSON.parse(metaStr);
            let metaChanged = false;
            const removedPaths: string[] = [];
            // 고아 입양: .trash 에 실재하지만 meta 에 없는 파일(과거 삭제 실패로
            // meta 만 지워진 잔재 등)은 지금 시각으로 등록해 보관 기한(3일)의
            // 시계를 다시 돌린다 — 등록이 없으면 자동 정리 대상에서 영구히 빠진다.
            try {
              const actual = (
                await this.services.backend.listFiles(
                  projectPath(imgDir, projectName, sceneDir, IMAGE_TRASH_DIR),
                )
              ).filter(isOutputImageFile);
              for (const f of actual) {
                if (!(f in meta)) {
                  meta[f] = now;
                  metaChanged = true;
                }
              }
            } catch (error) {
              // The directory inventory is incomplete; leave this metadata unchanged for retry.
              console.warn(
                '휴지통 자동 정리: 이미지 목록을 읽지 못해 건너뜁니다:',
                trashMetaPath,
                error,
              );
              continue;
            }
            for (const [filename, deletedAt] of Object.entries(meta)) {
              const age = now - deletedAt;
              if (age >= IMAGE_RETENTION_MS) {
                const trashPath = projectPath(
                  imgDir,
                  projectName,
                  sceneDir,
                  IMAGE_TRASH_DIR,
                  filename,
                );
                let removed = false;
                try {
                  await this.services.backend.deleteFile(trashPath);
                  removed = true;
                } catch (error) {
                  console.warn(
                    '휴지통 자동 정리: 이미지 삭제 실패, 존재 확인 후 재시도:',
                    trashPath,
                    error,
                  );
                  // ENOENT(이미 없음)만 정리로 간주 — 잠금 등 실패는 meta 를
                  // 남겨 다음 자동 정리에서 재시도한다.
                  removed = !(await this.services.backend
                    .existFile(trashPath)
                    .catch(() => true));
                }
                if (removed) {
                  delete meta[filename];
                  metaChanged = true;
                  removedPaths.push(trashPath);
                }
              }
            }
            try {
              await this.services.imageService.invalidateCacheBatch(
                removedPaths,
              );
            } catch (error) {
              // Derived thumbnails can be regenerated; metadata must still describe completed deletes.
              console.warn('휴지통 자동 정리 후 썸네일 캐시 정리 실패:', error);
            }
            if (metaChanged) {
              await persistService.write(
                this.services.backend,
                trashMetaPath,
                JSON.stringify(meta),
              );
            }
          } catch (error) {
            // Optional cleanup retries unreadable or unwritable metadata without replacing it.
            console.warn(
              '휴지통 자동 정리: 이미지 메타데이터 처리 실패:',
              trashMetaPath,
              error,
            );
          }
        }
      }
    }
  }
}
