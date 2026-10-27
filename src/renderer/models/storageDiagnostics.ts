import {
  STORAGE_MARKER_FILE,
  PROJECT_META_FILE,
  PROJECT_JSON_FILE,
} from './storageLayout';
import {
  WORKSPACE_ROOT,
  PROJECT_JSON_ROOT,
  PROJECT_IMAGE_ROOTS,
  workspacePath,
} from './projectPaths';
import { isOutputImageFile } from './imageFormats';

export interface StorageDiagnosticRow {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'info' | 'error';
  detail: string;
}

export interface BrokenStorageEntry {
  dir: string;
  name: string;
  hasBak: boolean;
  hasImages: boolean;
}

export interface StorageDiagnosticPorts {
  permissionStatus: () => Promise<{ required: boolean; granted: boolean }>;
  workspace: boolean;
  existFile: (path: string) => Promise<boolean>;
  listFiles: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  getFreeSpace: () => Promise<number | null>;
  listProjects: () => string[];
  filterVisibleProjects: (names: string[]) => string[];
}

export interface StorageDiagnosticResult {
  rows: StorageDiagnosticRow[];
  permissionWarn: boolean;
  fuseWarn: boolean;
  incomplete: boolean;
  canRepair: boolean;
  broken: BrokenStorageEntry[];
}

/** Read-only diagnostic probes. An unsuccessful read never means absent data. */
export async function collectStorageDiagnostics(
  ports: StorageDiagnosticPorts,
  signal?: AbortSignal,
): Promise<StorageDiagnosticResult> {
  const rows: StorageDiagnosticRow[] = [];
  const broken: BrokenStorageEntry[] = [];
  let permissionWarn = false;
  let permissionKnown = false;
  let fuseWarn = false;
  let incomplete = false;
  let layoutVerified = false;
  let projectRootRead = false;

  const checkActive = () => {
    if (signal?.aborted)
      throw signal.reason ?? new Error('저장소 진단이 취소되었습니다.');
  };
  const probe = async <T>(
    id: string,
    label: string,
    read: () => Promise<T>,
  ) => {
    checkActive();
    try {
      const value = await read();
      checkActive();
      return { ok: true as const, value };
    } catch (error) {
      checkActive();
      incomplete = true;
      rows.push({
        id,
        label,
        status: 'error',
        detail: `확인 실패: ${String(error)}`,
      });
      return { ok: false as const };
    }
  };
  const namedJson = (raw: string): string => {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('name' in value) ||
      typeof value.name !== 'string' ||
      !value.name
    ) {
      throw new Error('프로젝트 이름이 있는 JSON 객체가 아닙니다.');
    }
    return value.name;
  };

  const permission = await probe(
    'permission',
    '모든 파일 접근 권한',
    async () => {
      const status = await ports.permissionStatus();
      if (
        !status ||
        typeof status.required !== 'boolean' ||
        typeof status.granted !== 'boolean'
      ) {
        throw new Error('권한 상태 응답을 해석할 수 없습니다.');
      }
      return status;
    },
  );
  if (permission.ok) {
    permissionKnown = true;
    permissionWarn = permission.value.required && !permission.value.granted;
    rows.push({
      id: 'permission',
      label: '모든 파일 접근 권한',
      status: permissionWarn ? 'warn' : 'ok',
      detail: !permission.value.required
        ? '이 기기는 별도의 모든 파일 접근 권한 대상이 아닙니다.'
        : permissionWarn
          ? '미허용 — 기존 파일이 시스템에 의해 숨겨질 수 있습니다.'
          : '허용됨',
    });
  }

  const marker = await probe('layout', '저장소 배치', () =>
    ports.existFile(STORAGE_MARKER_FILE),
  );
  if (marker.ok) {
    layoutVerified = !ports.workspace || marker.value;
    rows.push({
      id: 'layout',
      label: '저장소 배치',
      status: ports.workspace ? (marker.value ? 'ok' : 'warn') : 'info',
      detail: ports.workspace
        ? marker.value
          ? '신 배치(workspace) · 마커 정상'
          : '신 배치인데 마커 파일이 보이지 않습니다. 저장소 접근 상태를 확인해 주세요.'
        : '구 배치(마이그레이션 전)',
    });
  }

  const projects = await probe('projects', '프로젝트 인식', async () => {
    const recognized = ports.listProjects();
    const visibleCount = ports.filterVisibleProjects(recognized).length;
    if (!ports.workspace) {
      const jsons = (await ports.listFiles(PROJECT_JSON_ROOT)).filter(
        (name) => !name.startsWith('.') && name.endsWith('.json'),
      );
      checkActive();
      const outputs = await ports.listFiles('outs');
      checkActive();
      const outputCount = outputs.filter(
        (name) => !name.startsWith('.'),
      ).length;
      fuseWarn = jsons.length === 0 && outputCount > 0;
      return fuseWarn
        ? `프로젝트 파일이 0개인데 결과물 폴더가 ${outputCount}개 존재 — 파일 숨김 의심`
        : `프로젝트 파일 ${jsons.length}개 · 앱 인식 ${recognized.length}개`;
    }

    const dirs = (await ports.listFiles(WORKSPACE_ROOT)).filter(
      (name) => !name.startsWith('.'),
    );
    checkActive();
    projectRootRead = true;
    let active = 0;
    let trashed = 0;
    let hiddenMetadata = 0;
    let unverified = 0;
    let internalBroken = 0;
    for (const dir of dirs) {
      checkActive();
      const meta = await probe(`metadata:${dir}`, `${dir} 정보 파일`, () =>
        ports.existFile(workspacePath(dir, PROJECT_META_FILE)),
      );
      if (!meta.ok) {
        unverified += 1;
        continue;
      }
      if (!meta.value) hiddenMetadata += 1;
      const entry = await probe(
        `entry:${dir}`,
        `${dir} 프로젝트 파일`,
        async () => {
          if (await ports.existFile(workspacePath(dir, PROJECT_JSON_FILE)))
            return 'active';
          checkActive();
          if (
            await ports.existFile(
              workspacePath(dir, `${PROJECT_JSON_FILE}.deleted`),
            )
          )
            return 'trashed';
          checkActive();
          return 'broken';
        },
      );
      if (!entry.ok) {
        unverified += 1;
        continue;
      }
      if (entry.value === 'active') {
        active += 1;
        continue;
      }
      if (entry.value === 'trashed') {
        trashed += 1;
        continue;
      }

      const candidate = await probe(
        `recovery:${dir}`,
        `${dir} 복구 자료`,
        async () => {
          let name = dir;
          let metadataNamed = false;
          if (meta.value) {
            const raw = await ports.readFile(
              workspacePath(dir, PROJECT_META_FILE),
            );
            checkActive();
            try {
              name = namedJson(raw);
              metadataNamed = true;
            } catch (error) {
              rows.push({
                id: `metadata-content:${dir}`,
                label: `${dir} 정보 파일`,
                status: 'warn',
                detail: `정보 파일을 해석할 수 없습니다: ${String(error)}`,
              });
            }
          }
          checkActive();
          let hasBak = false;
          const backupPath = workspacePath(dir, `${PROJECT_JSON_FILE}.bak`);
          if (await ports.existFile(backupPath)) {
            checkActive();
            const raw = await ports.readFile(backupPath);
            checkActive();
            try {
              const backupName = namedJson(raw);
              if (!metadataNamed) name = backupName;
              hasBak = true;
            } catch (error) {
              rows.push({
                id: `backup:${dir}`,
                label: `${name} 백업본`,
                status: 'warn',
                detail: `백업본을 해석할 수 없습니다: ${String(error)}`,
              });
            }
          }
          checkActive();
          if (ports.filterVisibleProjects([name]).length === 0) return null;
          let hasImages = false;
          const outputsPath = workspacePath(dir, 'outs');
          if (await ports.existFile(outputsPath)) {
            checkActive();
            const scenes = (await ports.listFiles(outputsPath)).filter(
              (scene) => !scene.startsWith('.'),
            );
            for (const scene of scenes) {
              checkActive();
              const images = await ports.listFiles(
                workspacePath(dir, 'outs', scene),
              );
              checkActive();
              if (images.some(isOutputImageFile)) {
                hasImages = true;
                break;
              }
            }
          }
          if (!hasImages) {
            for (const imageRoot of PROJECT_IMAGE_ROOTS) {
              if (imageRoot === 'outs') continue;
              checkActive();
              const imagesPath = workspacePath(dir, imageRoot);
              if (await ports.existFile(imagesPath)) {
                checkActive();
                const images = await ports.listFiles(imagesPath);
                checkActive();
                if (images.some((entryName) => !entryName.startsWith('.'))) {
                  hasImages = true;
                  break;
                }
              }
            }
          }
          return { dir, name, hasBak, hasImages };
        },
      );
      if (!candidate.ok) {
        unverified += 1;
        continue;
      }
      if (candidate.value) broken.push(candidate.value);
      else internalBroken += 1;
    }
    fuseWarn = hiddenMetadata > 0;
    return `프로젝트 폴더 ${dirs.length}개 · 정상 ${active}개 · 화면 표시 ${visibleCount}개 · 미인식 ${broken.length}개${
      trashed ? ` · 휴지통 ${trashed}개` : ''
    }${internalBroken ? ` · 내부용 잔재 ${internalBroken}개` : ''}${
      unverified ? ` · 확인 실패 ${unverified}개` : ''
    }${hiddenMetadata ? ` · 정보 파일이 보이지 않는 폴더 ${hiddenMetadata}개 — 파일 숨김 의심` : ''}`;
  });
  if (projects.ok) {
    rows.push({
      id: 'projects',
      label: '프로젝트 인식',
      status: fuseWarn || broken.length ? 'warn' : incomplete ? 'info' : 'ok',
      detail: projects.value,
    });
  }

  const config = await probe('config', '설정 파일(config.json)', () =>
    ports.existFile('config.json'),
  );
  if (config.ok)
    rows.push({
      id: 'config',
      label: '설정 파일(config.json)',
      status: 'info',
      detail: config.value ? '보임' : '보이지 않음 (최초 실행이면 정상)',
    });

  const space = await probe('space', '저장 공간 여유', () =>
    ports.getFreeSpace(),
  );
  if (space.ok) {
    if (space.value === null) {
      incomplete = true;
      rows.push({
        id: 'space',
        label: '저장 공간 여유',
        status: 'info',
        detail: '이 저장소의 여유 공간 정보를 확인할 수 없습니다.',
      });
    } else if (!Number.isFinite(space.value) || space.value < 0) {
      incomplete = true;
      rows.push({
        id: 'space',
        label: '저장 공간 여유',
        status: 'error',
        detail: '저장소가 유효하지 않은 여유 공간 값을 반환했습니다.',
      });
    } else {
      rows.push({
        id: 'space',
        label: '저장 공간 여유',
        status: space.value < 500 * 1024 * 1024 ? 'warn' : 'ok',
        detail: `${(space.value / (1024 * 1024 * 1024)).toFixed(1)} GB`,
      });
    }
  }
  checkActive();
  return {
    rows,
    permissionWarn,
    fuseWarn,
    incomplete,
    broken,
    canRepair:
      ports.workspace &&
      permissionKnown &&
      !permissionWarn &&
      !fuseWarn &&
      layoutVerified &&
      projectRootRead,
  };
}
