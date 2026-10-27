import { v4 } from 'uuid';
import {
  backend,
  isMobile,
  gameService,
  imageService,
  taskQueueService,
  trashService,
} from '.';
import { platform } from './platform';
import { dataUriToBase64 } from './imageDataUri';
import { ImageCache as LRUCache } from './ImageCache';
import { ImageWorkQueue } from './ImageWorkQueue';
import type { NaiRequestOptions } from './requestTiming';
import { NaiOutcomeUnknownError } from '../backends/genVendors/naiErrors';
import type { ModelVersion } from '../backends/imageGen';
import { getAppState } from './appStateRef';
import type { GenericScene, InpaintScene, Scene, Session } from './types';
import { assert } from './util';
import { isOutputImageFile, PNG_IMAGE_EXT } from './imageFormats';
import {
  projectPath,
  PROJECT_IMAGE_ROOTS,
  PROJECT_SCENE_IMAGE_ROOTS,
  PROJECT_SCENE_MASK_ROOTS,
  type ProjectImageRoot,
} from './projectPaths';

export const supportedImageSizes = [200, 400, 500];
const imageDirList = [...PROJECT_SCENE_IMAGE_ROOTS];
const maskDirList = [...PROJECT_SCENE_MASK_ROOTS];

const naturalSort = (a: string, b: string) => {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

export class ImageService extends EventTarget {
  private refreshBatchInFlight = new Map<string, Promise<void>>();

  private readonly imageWork = new ImageWorkQueue(platform.exportConcurrency);

  private readonly imageReads = new Map<string, Promise<string | null>>();

  images: { [key: string]: { [key: string]: string[] } };

  inpaints: { [key: string]: { [key: string]: string[] } };

  cache: LRUCache<string, string>;

  mutexes: { [key: string]: Promise<void> };

  // 인코딩된 바이브 이미지 존재 여부 캐시 (성능 최적화)
  encodedVibeExistsCache: LRUCache<string, boolean>;

  constructor() {
    super();
    this.images = {};
    this.inpaints = {};
    this.cache = new LRUCache(
      platform.imageCacheSize,
      platform.imageCacheBytes,
    );
    this.mutexes = {};
    this.encodedVibeExistsCache = new LRUCache(platform.encodedVibeCacheSize);
  }

  private async acquireMutex(path: string) {
    while (this.mutexes[path]) {
      await this.mutexes[path];
    }

    let release!: () => void;
    this.mutexes[path] = new Promise<void>((resolve) => {
      release = resolve;
    });
    (this.mutexes[path] as any).resolve = release;
  }

  private releaseMutex(path: string) {
    const { resolve } = this.mutexes[path] as any;
    delete this.mutexes[path];
    if (resolve) resolve();
  }

  async renameImage(oldPath: string, newPath: string) {
    if (oldPath === newPath) return;
    try {
      await this.acquireMutex(oldPath);
      await this.acquireMutex(newPath);
      await backend.renameFile(oldPath, newPath);
      await this.onRenameFile(oldPath, newPath);
    } finally {
      this.releaseMutex(newPath);
      this.releaseMutex(oldPath);
    }
  }

  async onRenameFile(oldPath: string, newPath: string) {
    if (oldPath === newPath) return;
    const oldPathParts = oldPath.split('/');
    const newPathParts = newPath.split('/');
    const oldDir = oldPathParts[oldPathParts.length - 2];
    const newDir = newPathParts[newPathParts.length - 2];
    assert(oldDir !== 'fastcache' && newDir !== 'fastcache');
    const oldPaths = [];
    const newPaths = [];
    for (const imageSize of supportedImageSizes) {
      oldPaths.push(this.getSmallImagePath(oldPath, imageSize));
      newPaths.push(this.getSmallImagePath(newPath, imageSize));
    }
    for (const path of oldPaths) {
      await this.acquireMutex(path);
    }
    for (const path of newPaths) {
      await this.acquireMutex(path);
    }
    try {
      for (let i = 0; i < oldPaths.length; i++) {
        const oldThumbnailPath = oldPaths[i];
        const newThumbnailPath = newPaths[i];
        try {
          await backend.renameFile(oldThumbnailPath, newThumbnailPath);
        } catch {
          // The source image already moved; absent derived thumbnails are regenerated on demand.
        }
      }
      this.cache.move(oldPath, newPath);
      for (const imageSize of supportedImageSizes) {
        this.cache.move(
          this.getSmallImagePath(oldPath, imageSize),
          this.getSmallImagePath(newPath, imageSize),
        );
      }
    } finally {
      for (const path of oldPaths) {
        this.releaseMutex(path);
      }
      for (const path of newPaths) {
        this.releaseMutex(path);
      }
    }
  }

  async invalidateCache(path: string) {
    if (path.includes('fastcache')) {
      return;
    }
    await this.acquireMutex(path);
    for (const imageSize of supportedImageSizes) {
      const smallPath = this.getSmallImagePath(path, imageSize);
      await this.acquireMutex(smallPath);
    }
    try {
      this.cache.delete(path);
      for (const imageSize of supportedImageSizes) {
        const smallPath = this.getSmallImagePath(path, imageSize);
        this.cache.delete(smallPath);
        try {
          await backend.deleteFile(smallPath);
        } catch (error) {
          // Thumbnail cleanup must not prevent releasing the image mutexes.
          console.warn('이미지 썸네일 캐시 정리 실패:', smallPath, error);
        }
      }
    } finally {
      for (const imageSize of supportedImageSizes) {
        const smallPath = this.getSmallImagePath(path, imageSize);
        this.releaseMutex(smallPath);
      }
      this.releaseMutex(path);
    }
    this.dispatchEvent(
      new CustomEvent('image-cache-invalidated', { detail: { path } }),
    );
  }

  /**
   * 같은 디렉터리의 여러 이미지 캐시를 한 번에 정리한다.
   *
   * 휴지통 일괄 삭제에서 파일마다 3개 썸네일을 직렬 삭제하면 Android
   * 브리지 호출과 리사이즈 mutex 대기가 이미지 수만큼 누적된다. 메모리 키는
   * 개별 제거하되, 디스크 fastcache는 디렉터리당 한 번만 제거한다.
   */
  async invalidateCacheBatch(paths: string[]): Promise<void> {
    const originals = Array.from(
      new Set(paths.filter((path) => path && !path.includes('/fastcache/'))),
    );
    if (originals.length === 0) return;

    const lockPaths: string[] = [];
    for (const path of originals) {
      lockPaths.push(path);
      for (const imageSize of supportedImageSizes) {
        lockPaths.push(this.getSmallImagePath(path, imageSize));
      }
    }

    // 기존 invalidateCache/onRenameFile과 같은 원본→썸네일 순서를 유지한다.
    for (const path of lockPaths) {
      await this.acquireMutex(path);
    }
    try {
      const cacheDirs = new Set<string>();
      for (const path of originals) {
        this.cache.delete(path);
        for (const imageSize of supportedImageSizes) {
          const smallPath = this.getSmallImagePath(path, imageSize);
          this.cache.delete(smallPath);
          const marker = '/fastcache/';
          const markerIndex = smallPath.lastIndexOf(marker);
          if (markerIndex >= 0) {
            cacheDirs.add(smallPath.slice(0, markerIndex + marker.length - 1));
          }
        }
      }

      for (const cacheDir of cacheDirs) {
        try {
          await backend.deleteDir(cacheDir);
        } catch {
          // 캐시는 파생 데이터다. 폴더가 없거나 정리에 실패해도 원본 삭제·복원
          // 성공 여부를 뒤집지 않으며, 다음 썸네일 생성 때 다시 정리된다.
        }
      }
    } finally {
      for (let i = lockPaths.length - 1; i >= 0; i--) {
        this.releaseMutex(lockPaths[i]);
      }
    }

    // 경로별 이벤트 N회 대신 한 번만 알려 대량 삭제 시 씬 카드 전체가 N번
    // 다시 그려지는 것을 막는다. path는 기존 리스너 호환용이다.
    this.dispatchEvent(
      new CustomEvent('image-cache-invalidated', {
        detail: { path: originals[0], paths: originals },
      }),
    );
  }

  async fetchVibeImage(session: Session, name: string) {
    if (!name) return null;
    const path = `${imageService.getVibesDir(session)}/${name.split('/').pop()!}`;
    return await this.fetchImage(path);
  }

  async fetchEncodedVibeImage(session: Session, name: string, info: number) {
    const path = `${imageService.getEncodedVibesDir(session)}/${name
      .split('/')
      .pop()!}&info=${info}`;
    return await this.fetchImage(path);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  async writeVibeImage(session: Session, name: string, data: string) {
    const path = `${imageService.getVibesDir(session)}/${name.split('/').pop()!}`;
    await backend.writeDataFile(path, data);
    await imageService.invalidateCache(path);
  }

  async fetchReferenceImage(session: Session, name: string) {
    const path = `${imageService.getReferenceDir(session)}/${name.split('/').pop()!}`;
    return await this.fetchImage(path);
  }

  async writeReferenceImage(session: Session, name: string, data: string) {
    const resized = await this.normalizeReferenceImage(data);
    const path = `${imageService.getReferenceDir(session)}/${name.split('/').pop()!}`;
    await backend.writeDataFile(path, resized);
    await imageService.invalidateCache(path);
  }

  private async readImage(path: string): Promise<string | null> {
    const cached = this.cache.get(path);
    if (cached !== null) return cached;
    return this.imageWork.run(async () => {
      const alreadyLoaded = this.cache.get(path);
      if (alreadyLoaded !== null) return alreadyLoaded;
      if (!(await backend.existFile(path))) return null;
      const data = await backend.readDataFile(path);
      this.cache.set(path, data);
      return data;
    });
  }

  async fetchImage(path: string, holdMutex = true): Promise<string | null> {
    // Thumbnail callers already own their path mutex. Joining a caller waiting
    // for that mutex would deadlock, so only independent callers share this flight.
    if (!holdMutex) return this.readImage(path);
    const existing = this.imageReads.get(path);
    if (existing) return existing;
    const pending = (async () => {
      await this.acquireMutex(path);
      try {
        return await this.readImage(path);
      } finally {
        this.releaseMutex(path);
      }
    })();
    this.imageReads.set(path, pending);
    try {
      return await pending;
    } finally {
      if (this.imageReads.get(path) === pending) this.imageReads.delete(path);
    }
  }

  async fetchImageSmall(path: string, size: number) {
    if (size === -1 || (isMobile && size === 500)) {
      return this.fetchImage(path);
    }
    const smallImagePath = this.getSmallImagePath(path, size);
    await this.acquireMutex(smallImagePath);
    try {
      // 캐시된 작은 이미지가 있는지 확인
      const resizedImageData = await this.fetchImage(smallImagePath, false);
      if (resizedImageData) {
        return resizedImageData;
      }
      // 캐시된 작은 이미지가 없음 - 원본 파일 존재 여부 확인 후 리사이즈 시도
      const originalExists = await backend.existFile(path);
      if (!originalExists) {
        // 원본 파일이 없으면 null 반환 (오류 로그 방지)
        return null;
      }
      try {
        await this.resizeImage(path, smallImagePath, size, size);
        const data = await this.fetchImage(smallImagePath, false);
        if (data) {
          this.cache.set(smallImagePath, data);
          return data;
        }
      } catch (e) {
        // 리사이즈 실패 시 원본 이미지 반환
        console.error('Failed to resize image, returning original:', path, e);
      }
      // 리사이즈 실패 시 원본 이미지 반환
      return this.fetchImage(path, false);
    } finally {
      this.releaseMutex(smallImagePath);
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getSmallImagePath(originalPath: string, size: number) {
    const pathParts = originalPath.split('/');
    const fileName = `${size.toString()}_${pathParts.pop()}`;
    pathParts.push('fastcache');
    pathParts.push(fileName!);
    return pathParts.join('/');
  }

  async resizeImage(
    inputPath: string,
    outputPath: string,
    maxWidth: number,
    maxHeight: number,
  ) {
    let scale = maxWidth <= 200 ? 1.25 : 1.1;
    if (isMobile) {
      scale = 1.0;
    }
    const scaledWidth = Math.ceil(scale * maxWidth);
    const scaledHeight = Math.ceil(scale * maxHeight);
    await this.imageWork.run(() =>
      backend.resizeImage({
        inputPath,
        outputPath,
        maxWidth: scaledWidth,
        maxHeight: scaledHeight,
      }),
    );
  }

  // NOTE there is race condition here
  // when deleted resource is being loaded up by somebody
  // we can end up with invalid cache
  // trikcy to handle without global lock
  // but only happens when "swap of scene names" is the case
  // let's just keep it simple; this is probably not common use case
  async onRenameScene(session: Session, oldName: string, newName: string) {
    // projectPath 경유 — 신 배치 활성 시 workspace/<물리폴더>/<root>/<씬> 로 분기.
    // 캐시 키도 projectPath 로 생성되므로 접두 매칭이 양 배치에서 일치한다.
    const { cache } = this.cache;
    const toDelete = [];
    for (const key of cache.keys()) {
      for (const imgDir of imageDirList.concat(maskDirList)) {
        if (key.startsWith(projectPath(imgDir, session.name, oldName))) {
          toDelete.push(key);
        }
      }
    }
    for (const key of toDelete) {
      this.cache.delete(key); // 외부 delete 사용 (용량 회계 유지)
    }
    for (const imgDir of imageDirList) {
      const oldPath = projectPath(imgDir, session.name, oldName);
      const newPath = projectPath(imgDir, session.name, newName);
      try {
        await backend.renameDir(oldPath, newPath);
      } catch (e) {
        console.error('rename scene error:', e);
      }
    }
    for (const imgDir of maskDirList) {
      const oldPath = projectPath(imgDir, session.name, `${oldName}.png`);
      const newPath = projectPath(imgDir, session.name, `${newName}.png`);
      try {
        await backend.renameFile(oldPath, newPath);
      } catch (e) {
        console.error('rename scene error:', e);
      }
    }
  }

  // 변형(인페인트) 씬 이름 변경의 파일 이동(2026-10-03 X15a). onRenameScene(일반 씬)과 달리
  //  · 대상은 inpaints/<씬> 폴더와 구형 마스크·원본 파일(inpaint_masks|inpaint_orgs/<씬>.png)뿐 —
  //    outs/ 는 일반 씬 몫이라 건드리지 않는다(같은 이름의 일반 씬 이미지가 딸려 가지 않게).
  //  · 새 이름 쪽에 이미 폴더·파일이 있으면 아무것도 옮기지 않고 throw(남은 이미지와 병합 방지).
  //  · 옮기는 중 실패하면 앞서 옮긴 것을 되돌리고 throw — 호출부는 이름·Map 을 바꾸지 않는다.
  async renameInpaintSceneFiles(
    session: Session,
    oldName: string,
    newName: string,
  ): Promise<void> {
    const moves: { from: string; to: string; dir: boolean }[] = [
      {
        from: projectPath('inpaints', session.name, oldName),
        to: projectPath('inpaints', session.name, newName),
        dir: true,
      },
      ...maskDirList.map((root) => ({
        from: projectPath(root, session.name, `${oldName}.${PNG_IMAGE_EXT}`),
        to: projectPath(root, session.name, `${newName}.${PNG_IMAGE_EXT}`),
        dir: false,
      })),
    ];
    const pending: typeof moves = [];
    for (const m of moves) {
      if (!(await backend.existFile(m.from))) continue;
      if (await backend.existFile(m.to)) {
        throw new Error(
          `새 이름 "${newName}"의 이미지 폴더나 마스크 파일이 이미 있어 이름을 바꾸지 않았습니다.`,
        );
      }
      pending.push(m);
    }
    const done: typeof moves = [];
    for (const m of pending) {
      try {
        if (m.dir) await backend.renameDir(m.from, m.to);
        else await backend.renameFile(m.from, m.to);
        done.push(m);
      } catch (e) {
        console.error('변형 씬 이름 변경 파일 이동 실패:', m.from, e);
        for (const d of done.reverse()) {
          try {
            if (d.dir) await backend.renameDir(d.to, d.from);
            else await backend.renameFile(d.to, d.from);
          } catch (e2) {
            console.error('변형 씬 이름 변경 되돌리기 실패:', d.to, e2);
          }
        }
        throw new Error(
          '이미지 폴더를 옮기지 못해 이름을 바꾸지 않았습니다(파일 잠금·권한 등). 잠시 뒤 다시 시도해 주세요.',
        );
      }
    }
    // 캐시 키는 옛 경로 기준 — 옮긴 경로의 캐시를 비운다(onRenameScene 과 같은 방식)
    const { cache } = this.cache;
    const stale: string[] = [];
    for (const key of cache.keys()) {
      for (const m of pending) {
        if (key.startsWith(m.from)) stale.push(key);
      }
    }
    for (const key of stale) this.cache.delete(key);
  }

  // Copy every image before removing any source. A failed copy must leave the
  // source scene intact; deleteDir is recursive and must never clean this folder.
  async mergeSceneImages(
    session: Session,
    sourceName: string,
    targetName: string,
  ): Promise<number> {
    if (sourceName === targetName) return 0;
    const transfers: Array<{ source: string; destination: string }> = [];
    for (const imgDir of imageDirList) {
      const srcDir = projectPath(imgDir, session.name, sourceName);
      const dstDir = projectPath(imgDir, session.name, targetName);
      // Both backends return [] only for missing directories. Access errors
      // must propagate, otherwise an unreadable scene looks empty and is lost.
      const files = (await backend.listFiles(srcDir)).filter(isOutputImageFile);
      if (files.length === 0) continue;
      const taken = new Set(await backend.listFiles(dstDir));
      for (const file of files) {
        let destinationName = file;
        if (taken.has(destinationName)) {
          const dot = file.lastIndexOf('.');
          const base = dot >= 0 ? file.slice(0, dot) : file;
          const extension = dot >= 0 ? file.slice(dot) : '';
          let suffix = 1;
          while (taken.has(`${base}_merged${suffix}${extension}`)) suffix++;
          destinationName = `${base}_merged${suffix}${extension}`;
        }
        taken.add(destinationName);
        transfers.push({
          source: `${srcDir}/${file}`,
          destination: `${dstDir}/${destinationName}`,
        });
      }
    }

    const ownedDestinations: string[] = [];
    try {
      for (const transfer of transfers) {
        // Register before copying: a failed copy may have created partial bytes.
        ownedDestinations.push(transfer.destination);
        await backend.copyFile(transfer.source, transfer.destination);
      }
    } catch (error) {
      for (const destination of ownedDestinations.reverse()) {
        try {
          await backend.deleteFile(destination);
        } catch (cleanupError) {
          // Preserve the primary failure and every original even if cleanup fails.
          console.warn(
            '씬 병합의 미완료 복사본 정리 실패:',
            destination,
            cleanupError,
          );
        }
      }
      throw error;
    }

    try {
      for (const transfer of transfers) {
        // Cleanup failure is visible; the caller retains the source scene.
        // Every image already has a complete destination copy at this point.
        await backend.deleteFile(transfer.source);
      }
    } finally {
      // Only this exact scene's keys, never a sibling sharing its name prefix.
      const prefixes = imageDirList
        .concat(maskDirList)
        .map((dir) => `${projectPath(dir, session.name, sourceName)}/`);
      for (const key of this.cache.cache.keys()) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) {
          this.cache.delete(key);
        }
      }
    }
    return transfers.length;
  }

  async onRenameSession(oldName: string, newName: string) {
    const { cache } = this.cache;
    const toDelete = [];
    for (const key of cache.keys()) {
      if (key.includes(`/${oldName}/`)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      this.cache.delete(key); // 외부 delete 사용 (용량 회계 유지)
    }
    // Preflight every root before moving one. listFiles returns [] for missing
    // folders and cannot distinguish absence from an empty image directory.
    // existFile preserves access errors, so a denied root cannot be skipped.
    const existing: ProjectImageRoot[] = [];
    for (const dir of PROJECT_IMAGE_ROOTS) {
      if (await backend.existFile(projectPath(dir, oldName)))
        existing.push(dir);
    }
    const moved: ProjectImageRoot[] = [];
    for (const dir of existing) {
      try {
        await backend.renameDir(
          projectPath(dir, oldName),
          projectPath(dir, newName),
        );
        moved.push(dir);
      } catch {
        for (const back of moved) {
          try {
            await backend.renameDir(
              projectPath(back, newName),
              projectPath(back, oldName),
            );
          } catch (e2) {
            console.error('이름변경 롤백 실패 — 수동 확인 필요:', back, e2);
          }
        }
        throw new Error(
          `이미지 폴더(${dir}) 이동에 실패해 이름변경을 취소했습니다. ` +
            `앱 외부에서 해당 폴더를 사용 중인지 확인해주세요.`,
        );
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  async resizeImageBrowser(
    dataUrl: string,
    _maxWidth: number,
    _maxHeight: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = dataUrl;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
    });
  }

  async normalizeReferenceImage(data: string): Promise<string> {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return data;
    const img = new Image();
    img.src = base64ToDataUri(data);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const { canvasWidth, canvasHeight } = this.chooseReferenceResolution(
      img.width,
      img.height,
    );
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    const scale = Math.min(canvasWidth / img.width, canvasHeight / img.height);
    const w = Math.floor(scale * img.width);
    const h = Math.floor(scale * img.height);
    const x = Math.floor((canvasWidth - w) / 2);
    const y = Math.floor((canvasHeight - h) / 2);

    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.drawImage(img, x, y, w, h);
    // NAI Precise Reference 스펙: 3채널 RGB 필요. HTML Canvas는 항상 RGBA이므로
    // alpha 채널을 포함하지 않는 JPEG 0.95로 인코딩하여 RGBA→RGB 변환.
    // 참고: sunanakgo/NAIS2 processCharacterImage, DNT-LAB/NAIA _letterbox
    return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
  }

  /**
   * 이미 저장된 레퍼런스 이미지(base64)를 NAI API 전송용 JPEG 3채널로 재인코딩.
   * 기존 사용자가 업로드한 RGBA PNG 레퍼런스를 재업로드 없이 호환시키기 위해
   * 생성 시점에 호출. letterbox는 수행하지 않음 (저장 시점에 이미 완료됨).
   */
  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  async reencodeReferenceForApi(data: string): Promise<string> {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return data;
      const img = new Image();
      img.src = base64ToDataUri(data);
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });
      canvas.width = img.width;
      canvas.height = img.height;
      // alpha 픽셀이 투명한 경우를 대비해 검정 배경 채움 (letterbox 색상과 일치).
      ctx.fillStyle = 'black';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
    } catch (e) {
      console.warn('Failed to re-encode reference image as JPEG:', e);
      return data;
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  chooseReferenceResolution(width: number, height: number) {
    const ratio = width / height;
    if (ratio >= 0.9 && ratio <= 1.1)
      return { canvasWidth: 1472, canvasHeight: 1472 };
    if (ratio < 1) return { canvasWidth: 1024, canvasHeight: 1536 };
    return { canvasWidth: 1536, canvasHeight: 1024 };
  }

  getOutputs(session: Session, scene: GenericScene) {
    if (scene.type === 'scene') {
      return this.getImages(session, scene);
    }
    return this.getInPaints(session, scene);
  }

  getImages(session: Session, scene: Scene) {
    if (!(session.name in this.images)) {
      return [];
    }
    if (!(scene.name in this.images[session.name])) {
      return [];
    }
    return this.images[session.name][scene.name];
  }

  getInPaints(session: Session, scene: InpaintScene) {
    if (!(session.name in this.inpaints)) {
      return [];
    }
    if (!(scene.name in this.inpaints[session.name])) {
      return [];
    }
    return this.inpaints[session.name][scene.name];
  }

  getOutputDir(session: Session, scene: GenericScene) {
    if (scene.type === 'scene') {
      return this.getImageDir(session, scene);
    }
    return this.getInPaintDir(session, scene);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getImageDir(session: Session, scene: Scene) {
    return projectPath('outs', session.name, scene.name);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getInPaintDir(session: Session, scene: InpaintScene) {
    return projectPath('inpaints', session.name, scene.name);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getVibesDir(session: Session) {
    return projectPath('vibes', session.name);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getEncodedVibesDir(session: Session) {
    return projectPath('vibes', session.name, 'encoded');
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getReferenceDir(session: Session) {
    return projectPath('references', session.name);
  }

  // primeCache: 방금 쓴 PNG(base64)를 읽기 캐시에 바로 넣는다. 미러 일괄 예약처럼
  // 쓰자마자 같은 파일을 다시 읽는 경로(씬 카드 표시·예약 핸들러)의 디스크 왕복을
  // 없앤다 — 넣는 값은 readDataFile 이 돌려줄 data URI 와 같은 모양(2026-10-02 P1).
  async storeVibeImage(session: Session, data: string, primeCache = false) {
    const path = `${imageService.getVibesDir(session)}/${v4()}.png`;
    await backend.writeDataFile(path, data);
    if (primeCache) {
      this.cache.set(path, `data:image/${PNG_IMAGE_EXT};base64,${data}`);
    }
    return path.split('/').pop()!;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  async storeEncodedVibeImage(
    session: Session,
    name: string,
    data: string,
    info: number,
  ) {
    const path = `${imageService.getEncodedVibesDir(session)}/${name}&info=${info}`;
    await backend.writeDataFile(path, data);
    return path.split('/').pop()!;
  }

  async storeReferenceImage(session: Session, data: string) {
    const resized = await this.normalizeReferenceImage(data);
    const path = `${imageService.getReferenceDir(session)}/${v4()}.png`;
    await backend.writeDataFile(path, resized);
    return path.split('/').pop()!;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getVibeImagePath(session: Session, name: string) {
    return `${imageService.getVibesDir(session)}/${name.split('/').pop()!}`;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getEncodedVibeImagePath(session: Session, name: string, info: number) {
    return `${imageService.getEncodedVibesDir(session)}/${name
      .split('/')
      .pop()!}&info=${info}`;
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- Preserve the instance image-service API for this stateless operation.
  getReferenceImagePath(session: Session, name: string) {
    return `${imageService.getReferenceDir(session)}/${name.split('/').pop()!}`;
  }

  // 반환값(트랙1 B4 이슈① 진단용): 'guarded'=디스크 0장인데 기존 목록을 방어
  // 유지 / 'files'=파일을 정상적으로 읽음(≥1장) / 'empty'=0장을 그대로 반영.
  // refreshBatch 가 'files'(저장소 접근 정상 증거)와 'guarded'를 대조해
  // 영구 소실 확정 씬을 자동 화해한다. 개별 호출부는 반환값을 무시해도 된다.
  async refresh(
    session: Session,
    scene: GenericScene,
    emitEvent: boolean = true,
    guardEmpty: boolean = false,
  ): Promise<'guarded' | 'files' | 'empty'> {
    const target = scene.type === 'scene' ? this.images : this.inpaints;
    if (!(session.name in target)) {
      target[session.name] = {};
    }
    const fileSet: any = {};
    let files = await backend.listFiles(this.getOutputDir(session, scene));
    files = files.filter(isOutputImageFile);
    files.sort(naturalSort);

    // 방어 (refreshBatch 전용): 기존 imageMap에 항목이 있었는데 파일시스템에서
    // 0개가 반환된 경우, 디렉토리 일시 접근 불가일 가능성이 높으므로 기존 상태 유지.
    // 개별 refresh(삭제 후 등)에서는 guardEmpty=false로 호출하여 정상 반영.
    if (guardEmpty && files.length === 0 && scene.imageMap.length > 0) {
      target[session.name][scene.name] = [...scene.imageMap];
      // 읽기 실패/접근 불가 의심: 디스크 0개인데 기존 목록은 N개 → 로그로 남겨 진단 가능하게.
      try {
        taskQueueService.addLog(
          'warn',
          '저장소',
          `"${session.name}/${scene.name}" 이미지 폴더를 읽지 못해 기존 목록(${scene.imageMap.length}장)을 유지했습니다. 저장소 접근을 확인하세요.`,
        );
      } catch {
        // Optional diagnostic/notification delivery must not replace the storage result.
      }
      if (emitEvent)
        this.dispatchEvent(
          new CustomEvent('updated', {
            detail: { batch: false, session, scene },
          }),
        );
      return 'guarded';
    }

    for (const file of files) {
      fileSet[file] = true;
    }
    // 같은 파일명이 중복 저장된 옛 imageMap은 React Grid의 중복 key와 동일 파일
    // 이중 표시를 만든다. 디스크에 실제 존재하는 첫 참조만 유지해 갱신 시 자가치유한다.
    const seen = new Set<string>();
    const newImageMap = scene.imageMap.filter((x: string) => {
      if (!(x in fileSet) || seen.has(x)) return false;
      seen.add(x);
      return true;
    });
    for (const file of files) {
      if (!seen.has(file)) {
        newImageMap.push(file);
        seen.add(file);
      }
    }
    scene.imageMap = newImageMap;
    target[session.name][scene.name] = [...scene.imageMap];
    if (scene.type === 'scene') {
      scene.mains = scene.mains.filter((x: string) => x in fileSet);
    }
    // 랭킹 죽은 참조 정리(트랙1 B4 이슈②): 부분 소실 시 imageMap/mains 는 위에서
    // 화해되지만 game/round 는 남아 nextRound 가 소실 이미지를 대진에 올렸다.
    // 랭크는 결번이 생기므로 cleanGame 으로 정규화(대진 로직의 전제).
    if (scene.game && scene.game.some((p) => !(p.path in fileSet))) {
      const alive = scene.game.filter((p) => p.path in fileSet);
      if (alive.length > 0) {
        gameService.cleanGame(alive);
        scene.game = alive;
      } else {
        scene.game = undefined;
      }
    }
    if (scene.round && scene.round.players.some((p) => !(p in fileSet))) {
      scene.round = undefined;
    }
    if (emitEvent)
      this.dispatchEvent(
        new CustomEvent('updated', {
          detail: { batch: false, session, scene },
        }),
      );
    return files.length > 0 ? 'files' : 'empty';
  }

  async refreshBatch(session: Session): Promise<void> {
    const inFlight = this.refreshBatchInFlight.get(session.name);
    if (inFlight) {
      await inFlight;
      return;
    }

    const refreshPromise = this.refreshBatchInternal(session);
    this.refreshBatchInFlight.set(session.name, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      if (this.refreshBatchInFlight.get(session.name) === refreshPromise) {
        this.refreshBatchInFlight.delete(session.name);
      }
    }
  }

  private async refreshBatchInternal(session: Session): Promise<void> {
    const allScenes: GenericScene[] = [
      ...session.scenes.values(),
      ...session.inpaints.values(),
    ];
    const results = await Promise.allSettled(
      allScenes.map((scene) => this.refresh(session, scene, false, true)),
    );
    // 유령 참조 자동 화해(트랙1 B4 이슈①): guardEmpty 가 목록을 방어 유지한
    // 씬('guarded')이 있는데 같은 프로젝트의 다른 씬이 파일을 정상적으로
    // 읽었다면('files' = 저장소 루트 접근 정상 증거), 해당 씬 폴더는 "일시
    // 접근 불가"가 아니라 영구 소실 — 실제(0장)로 화해해 무한 경고를 끊는다.
    // 증거가 없으면(전 씬 0장 = 루트/드라이브 미접근 가능성) 절대 정리하지
    // 않고 종전대로 방어 유지한다. 씬 자체는 제거하지 않는다(목록 화해만).
    const guarded: GenericScene[] = [];
    let evidence = false;
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      if (r.value === 'guarded') guarded.push(allScenes[i]);
      else if (r.value === 'files') evidence = true;
    });
    if (evidence && guarded.length > 0) {
      await Promise.allSettled(
        guarded.map(async (scene) => {
          await this.refresh(session, scene, false, false);
          try {
            taskQueueService.addLog(
              'warn',
              '저장소',
              `"${session.name}/${scene.name}" 이미지 폴더가 영구 소실된 것으로 확인되어 목록을 정리했습니다 (같은 프로젝트의 다른 씬은 정상 접근됨).`,
            );
          } catch {
            // Optional diagnostic/notification delivery must not replace the storage result.
          }
        }),
      );
    }
    this.dispatchEvent(
      new CustomEvent('updated', { detail: { batch: true, session } }),
    );
  }

  onAddImage(session: Session, scene: string, path: string) {
    if (!(session.name in this.images)) {
      this.images[session.name] = {};
    }
    if (!(scene in this.images[session.name])) {
      this.images[session.name][scene] = [];
    }
    const filename = path.split('/').pop()!;
    let changed = false;
    if (!this.images[session.name][scene].includes(filename)) {
      this.images[session.name][scene] = this.images[session.name][
        scene
      ].concat([filename]);
      changed = true;
    }
    const sceneObj = session.scenes.get(scene);
    if (sceneObj && !sceneObj.imageMap.includes(filename)) {
      sceneObj.imageMap.push(filename);
      changed = true;
    }
    // 완료 브리지·파일 스캔 경합으로 같은 경로가 다시 들어와도 히스토리와 그리드를
    // 중복 갱신하지 않는다. 한쪽 목록만 빠진 경우에는 위에서 정상 화해한다.
    if (!changed) return;
    if (isMobile)
      for (const size of platform.pregenThumbSizes)
        this.fetchImageSmall(path, size);
    // 생성 히스토리 수집용 — 새로 추가된 이미지의 경로까지 전달('updated'에는 없음)
    this.dispatchEvent(
      new CustomEvent('image-added', {
        detail: {
          session,
          sceneType: 'scene',
          sceneName: scene,
          filename,
          path,
        },
      }),
    );
    this.dispatchEvent(
      new CustomEvent('updated', {
        detail: { batch: false, session, scene: session.scenes.get(scene) },
      }),
    );
  }

  onAddInPaint(session: Session, scene: string, path: string) {
    if (!(session.name in this.inpaints)) {
      this.inpaints[session.name] = {};
    }
    if (!(scene in this.inpaints[session.name])) {
      this.inpaints[session.name][scene] = [];
    }
    const filename = path.split('/').pop()!;
    let changed = false;
    if (!this.inpaints[session.name][scene].includes(filename)) {
      this.inpaints[session.name][scene] = this.inpaints[session.name][
        scene
      ].concat([filename]);
      changed = true;
    }
    const sceneObj = session.inpaints.get(scene);
    if (sceneObj && !sceneObj.imageMap.includes(filename)) {
      sceneObj.imageMap.push(filename);
      changed = true;
    }
    if (!changed) return;
    if (isMobile)
      for (const size of platform.pregenThumbSizes)
        this.fetchImageSmall(path, size);
    this.dispatchEvent(
      new CustomEvent('image-added', {
        detail: {
          session,
          sceneType: 'inpaint',
          sceneName: scene,
          filename,
          path,
        },
      }),
    );
    this.dispatchEvent(
      new CustomEvent('updated', {
        detail: { batch: false, session, scene: session.inpaints.get(scene) },
      }),
    );
  }

  // 생성 직후 WebP 변환 중 파일 스캔이 먼저 발견한 임시 PNG 참조를 제거한다.
  // 파일 자체는 TaskHandlers가 처리하며, 여기서는 메모리/프로젝트 JSON 참조만 정리한다.
  removeImageReference(session: Session, scene: GenericScene, path: string) {
    const filename = path.split('/').pop()!;
    const target = scene.type === 'scene' ? this.images : this.inpaints;
    const list = target[session.name]?.[scene.name];
    if (list) {
      target[session.name][scene.name] = list.filter((x) => x !== filename);
    }
    scene.imageMap = scene.imageMap.filter((x) => x !== filename);
    if (scene.type === 'scene') {
      scene.mains = scene.mains.filter((x) => x !== filename);
      if (scene.game?.some((p) => p.path === filename)) {
        const alive = scene.game.filter((p) => p.path !== filename);
        if (alive.length > 0) {
          gameService.cleanGame(alive);
          scene.game = alive;
        } else {
          scene.game = undefined;
        }
      }
      if (scene.round?.players.includes(filename)) scene.round = undefined;
    }
  }

  async encodeVibeImage(
    session: Session,
    path: string,
    info: number,
    // 완료까지 기다리며 명시적 취소 신호만 전달한다.
    request?: NaiRequestOptions,
    modelVersion?: ModelVersion,
    beforeDispatch?: () => void,
  ) {
    const vibePath = this.getVibeImagePath(session, path);
    const data = await this.fetchVibeImage(session, vibePath);
    // Reading may outlive a queue Stop. Gate only the next paid dispatch;
    // once encoding starts its result must still be saved and cached.
    beforeDispatch?.();
    if (!data) return undefined;
    const encoded = await backend.encodeVibeImage({
      image: dataUriToBase64(data),
      info,
      ...(modelVersion !== undefined ? { modelVersion } : {}),
      ...(request ? { request } : {}),
    });
    try {
      await this.storeEncodedVibeImage(session, path, encoded, info);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failure = Object.assign(
        new Error(
          `바이브 인코딩 응답을 받았지만 결과 저장에 실패했습니다. 인코딩 비용이 청구되었을 수 있으므로 저장 상태와 NovelAI 사용량을 확인해 주세요.${detail ? ` (${detail})` : ''}`,
        ),
        { cause: error },
      );
      // Encoding has already completed. A disk failure must not pay to encode
      // the same input again automatically; do not retain another global blob.
      throw new NaiOutcomeUnknownError(failure);
    }

    // 인코딩 완료 후 캐시 업데이트
    const cacheKey = this.getEncodedVibeImagePath(session, path, info);
    this.encodedVibeExistsCache.set(cacheKey, true);

    this.dispatchEvent(new CustomEvent('encode-vibe', {}));
    return encoded;
  }

  async checkEncodedVibeImage(session: Session, path: string, info: number) {
    const vibePath = this.getEncodedVibeImagePath(session, path, info);

    // 캐시에서 먼저 확인 (성능 최적화)
    const cached = this.encodedVibeExistsCache.get(vibePath);
    if (cached !== null) {
      return cached;
    }

    // 캐시에 없으면 파일 시스템 확인
    const exists = await backend.existFile(vibePath);
    this.encodedVibeExistsCache.set(vibePath, exists);
    return exists;
  }
}

export function base64ToDataUri(data: string) {
  return `data:image/png;base64,${data}`;
}

export { dataUriToBase64 };

export function getMainImagePath(session: Session, scene: Scene) {
  if (scene.mains.length) {
    return `${imageService.getImageDir(session, scene)}/${scene.mains[0]}`;
  }
  const images = gameService.getOutputs(session, scene);
  if (images.length) {
    return `${imageService.getImageDir(session, scene)}/${images[0]}`;
  }
  return undefined;
}

export async function getMainImage(
  session: Session,
  scene: GenericScene,
  size: number,
) {
  if (scene.mains.length) {
    const path = `${imageService.getOutputDir(session, scene)}/${scene.mains[0]}`;
    const base64 = await imageService.fetchImageSmall(path, size);
    return base64;
  }
  const images = gameService.getOutputs(session, scene);
  if (images.length) {
    const path = `${imageService.getOutputDir(session, scene)}/${images[0]}`;
    return await imageService.fetchImageSmall(path, size);
  }
  return undefined;
}

// ── 이미지 즐겨찾기(mains) 중앙 헬퍼 (읽기 전용 미러 / 창 간 동기화) ──
// scene.mains 를 로컬에 반영하고, 같은 프로젝트를 연 다른 창에 op 를 전파한다.
// 소유 창은 자기 큐가 저장하고(=위임의 실체), 미러 창은 P0 가드가 디스크 쓰기를
// 드롭한다. 단일 창/모바일은 notifySessionOp 가 no-op 이라 종전 동작과 동일하다.
// filename 은 확장자 포함 파일명(경로 아님) — 호출부에서 path.split('/').pop() 처리.
export function setImageMain(
  session: Session,
  scene: GenericScene,
  filename: string,
  on: boolean,
) {
  const has = scene.mains.includes(filename);
  // 절대값 의미론 + 중복 push 방지
  if (on && !has) scene.mains.push(filename);
  else if (!on && has) scene.mains.splice(scene.mains.indexOf(filename), 1);
  // 창 간 위임: 같은 프로젝트를 연 다른 창에 절대값 op 를 전파(실패 무시).
  backend
    .notifySessionOp({
      project: session.name,
      sceneType: scene.type === 'inpaint' ? 'inpaint' : 'scene',
      sceneName: scene.name,
      filename,
      op: 'set-main',
      on,
    })
    .catch(() => {});
}

// 현재 상태를 반전(토글) — 기존 splice/push 토글 호출부를 이 헬퍼로 치환한다.
export function toggleImageMain(
  session: Session,
  scene: GenericScene,
  filename: string,
) {
  setImageMain(session, scene, filename, !scene.mains.includes(filename));
}

// 반환값: 삭제(휴지통 이동)에 실패한 파일 수.
// 실패 통지는 여기서 직접 한다 — 호출부 10여 곳이 반환값을 버려 실패가 무통지로
// 삼켜지던 문제(2026-07-26). appState 는 순환 import 회피를 위해 getAppState() 경유.
// 호출부는 이 알림을 다시 띄우지 않는다(중복 토스트, 2026-10-03 X13). 여러 씬을 돌며 한 번에
// 알려야 하는 일괄 호출부만 { notify: false } 로 끄고 반환값을 모아 직접 한 줄로 알린다.
export const deleteImageFiles = async (
  curSession: Session,
  paths: string[],
  scene?: GenericScene,
  opts?: { notify?: boolean },
): Promise<number> => {
  if (scene) {
    let failed = 0;
    try {
      // 휴지통으로 이동
      failed = await trashService.moveImagesToTrash(curSession, scene, paths);
      for (const path of paths) {
        try {
          await imageService.invalidateCache(path);
        } catch (e) {
          console.error('이미지 캐시 무효화 실패:', path, e);
        }
      }
    } finally {
      // 중간에 예외가 나도 목록 재로딩은 반드시 수행 — 안 하면 삭제된
      // 이미지가 화면에 그대로 남는다.
      await imageService.refresh(curSession, scene);
    }
    if (failed > 0 && opts?.notify !== false) {
      try {
        getAppState().pushMessage(
          `${
            failed
          }장의 이미지를 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.`,
        );
      } catch {
        // Optional diagnostic/notification delivery must not replace the storage result.
      }
    }
    return failed;
  }
  // scene이 없는 경우 OS 휴지통을 사용하고 실패 개수를 동일한 계약으로 반환한다.
  let failed = 0;
  try {
    for (const path of paths) {
      try {
        await backend.trashFile(path);
      } catch (error) {
        failed++;
        console.error('이미지 휴지통 이동 실패:', path, error);
        continue;
      }
      try {
        await imageService.invalidateCache(path);
      } catch (error) {
        console.error('이미지 캐시 무효화 실패:', path, error);
      }
    }
  } finally {
    await imageService.refreshBatch(curSession);
  }
  if (failed > 0 && opts?.notify !== false) {
    try {
      getAppState().pushMessage(
        `${failed}장의 이미지를 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.`,
      );
    } catch (error) {
      // 파일별 실패 수는 알림 UI가 이미 닫혔더라도 호출자에게 반환한다.
      console.warn('이미지 삭제 실패 알림 표시 실패:', error);
    }
  }
  return failed;
};

export const renameImage = async (oldPath: string, newPath: string) => {
  await imageService.renameImage(oldPath, newPath);
};

export function cropMirrorResultFromDataUri(
  dataUri: string,
  mirrorCropX?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      // mirrorCropX가 유효하면 정확한 위치 사용, 해상도 불일치 시 폴백
      const half = Math.floor(w / 2);
      const cropX =
        mirrorCropX && Math.abs(mirrorCropX - half) < 64
          ? mirrorCropX
          : half + 48;
      const cropW = w - cropX;
      const canvas = document.createElement('canvas');
      canvas.width = cropW;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, cropX, 0, cropW, h, 0, 0, cropW, h);
      resolve(
        canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
      );
    };
    img.onerror = reject;
    img.src = dataUri;
  });
}
