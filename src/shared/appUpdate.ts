export type UpdateChannel = 'private' | 'public';
export type UpdateAssetKind =
  | 'windows-portable'
  | 'windows-folder'
  | 'android-apk';

export interface UpdateAsset {
  kind: UpdateAssetKind;
  name: string;
  size: number;
  sha256: string;
}
export interface UpdateManifest {
  schema: 1;
  channel: UpdateChannel;
  appId: string;
  version: string;
  assets: UpdateAsset[];
}
export interface UpdateRelease {
  channel: UpdateChannel;
  version: string;
  releaseUrl: string;
  publishedAt: string;
  notes: string;
  asset: UpdateAsset;
}
export interface UpdateState {
  channel: UpdateChannel;
  connected: boolean;
  supported: boolean;
  version: string;
  snoozedUntil: number;
}
export interface UpdateProgress {
  phase: 'downloading' | 'ready';
  received: number;
  total: number;
  version: string;
}
export interface UpdateBackend {
  getState(): Promise<UpdateState>;
  claimStartupCheck(): Promise<boolean>;
  check(): Promise<UpdateRelease | null>;
  snooze(): Promise<void>;
  connect(token: string): Promise<void>;
  disconnect(): Promise<void>;
  download(version: string): Promise<void>;
  cancelDownload(): Promise<void>;
  install(): Promise<void>;
  cancelInstall(): Promise<void>;
  onInstallError(callback: (message: string) => void): () => void;
  onProgress(callback: (progress: UpdateProgress) => void): () => void;
}
export const UPDATE_MANIFEST_NAME = 'update-manifest.json';
export const UPDATE_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('업데이트 정보를 읽을 수 없습니다.');
  return value as Record<string, unknown>;
}

export function readUpdateManifest(
  value: unknown,
  expected: { channel: UpdateChannel; appId: string; version: string },
): UpdateManifest {
  const input = record(value);
  if (
    input.schema !== 1 ||
    input.channel !== expected.channel ||
    input.appId !== expected.appId ||
    input.version !== expected.version ||
    !Array.isArray(input.assets) ||
    input.assets.length !== 3
  )
    throw new Error('이 프로그램에 맞는 업데이트가 아닙니다.');
  const kinds = new Set<string>();
  const names = new Set<string>();
  const extensions: Record<UpdateAssetKind, string> = {
    'windows-portable': '.exe',
    'windows-folder': '.zip',
    'android-apk': '.apk',
  };
  const assets = input.assets.map((item) => {
    const asset = record(item);
    const kind = asset.kind as UpdateAssetKind;
    if (
      !Object.prototype.hasOwnProperty.call(extensions, kind) ||
      kinds.has(kind) ||
      typeof asset.name !== 'string' ||
      !asset.name ||
      /[/\\:]/.test(asset.name) ||
      [...asset.name].some((character) => character.charCodeAt(0) < 32) ||
      asset.name === '.' ||
      asset.name === '..' ||
      !asset.name.toLowerCase().endsWith(extensions[kind]) ||
      names.has(asset.name.toLowerCase()) ||
      !Number.isSafeInteger(asset.size) ||
      (asset.size as number) <= 0 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(asset.sha256)
    )
      throw new Error('업데이트 파일 정보가 올바르지 않습니다.');
    kinds.add(kind);
    names.add(asset.name.toLowerCase());
    return {
      kind,
      name: asset.name,
      size: asset.size as number,
      sha256: asset.sha256.toLowerCase(),
    };
  });
  return { schema: 1, ...expected, assets };
}

function parseVersion(version: string): {
  core: number[];
  pre: string[] | null;
} {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) throw new Error('업데이트 버전 정보를 읽을 수 없습니다.');
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split('.') ?? null;
  if (
    core.some((part) => !Number.isSafeInteger(part)) ||
    pre?.some(
      (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'),
    )
  )
    throw new Error('업데이트 버전 정보를 읽을 수 없습니다.');
  return { core, pre };
}

/** SemVer precedence, including numeric prerelease identifiers such as cupcake.10. */
export function compareReleaseVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index])
      return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.pre || !b.pre) return a.pre === b.pre ? 0 : a.pre ? -1 : 1;
  for (
    let index = 0;
    index < Math.max(a.pre.length, b.pre.length);
    index += 1
  ) {
    const x = a.pre[index];
    const y = b.pre[index];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn)
      return x.length !== y.length
        ? x.length > y.length
          ? 1
          : -1
        : x > y
          ? 1
          : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
