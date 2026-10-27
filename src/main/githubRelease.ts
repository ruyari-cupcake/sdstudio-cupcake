import { createHash } from 'crypto';
import {
  compareReleaseVersions,
  readUpdateManifest,
  UPDATE_MANIFEST_NAME,
  type UpdateAssetKind,
  type UpdateChannel,
  type UpdateRelease,
} from '../shared/appUpdate';

export interface GithubAsset {
  id: number;
  name: string;
  size: number;
  digest?: string | null;
}
export interface CheckedUpdate {
  release: UpdateRelease;
  asset: GithubAsset;
}
export interface GithubUpdateIdentity {
  owner: string;
  repo: string;
  appId: string;
  channel: UpdateChannel;
  version: string;
  kind: UpdateAssetKind;
}
type Fetch = typeof fetch;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('업데이트 정보를 읽을 수 없습니다.');
  return value as Record<string, unknown>;
}
function assets(value: unknown): GithubAsset[] {
  if (!Array.isArray(value)) throw new Error('업데이트 파일이 없습니다.');
  return value.map((item) => {
    const asset = object(item);
    if (
      !Number.isSafeInteger(asset.id) ||
      (asset.id as number) <= 0 ||
      typeof asset.name !== 'string' ||
      !Number.isSafeInteger(asset.size) ||
      (asset.size as number) <= 0
    )
      throw new Error('업데이트 파일 정보를 읽을 수 없습니다.');
    return asset as unknown as GithubAsset;
  });
}

async function readManifest(
  response: Response,
  asset: GithubAsset,
): Promise<Uint8Array> {
  if (!response.body) throw new Error('업데이트 파일 목록을 받지 못했습니다.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(asset.size);
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > bytes.byteLength)
        throw new Error('업데이트 파일 목록의 크기가 일치하지 않습니다.');
      bytes.set(value, received);
      received += value.byteLength;
    }
    if (received !== bytes.byteLength)
      throw new Error('업데이트 파일 목록을 끝까지 받지 못했습니다.');
    if (
      asset.digest &&
      asset.digest !==
        `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    )
      throw new Error(
        '게시된 업데이트 파일 목록과 받은 내용이 일치하지 않습니다.',
      );
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** URLs are derived only from this build's repository and authenticated asset IDs. */
export class GithubReleaseClient {
  private readonly api: string;

  constructor(
    readonly identity: GithubUpdateIdentity,
    private readonly request: Fetch = fetch,
  ) {
    if (
      !/^[A-Za-z0-9_.-]+$/.test(identity.owner) ||
      !/^[A-Za-z0-9_.-]+$/.test(identity.repo)
    )
      throw new Error('업데이트 저장소 설정이 올바르지 않습니다.');
    this.api = `https://api.github.com/repos/${identity.owner}/${identity.repo}`;
  }

  private headers(token?: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(this.identity.channel === 'private' && token
        ? { Authorization: `Bearer ${token}` }
        : {}),
    };
  }

  private failure(status: number): Error {
    if (status === 401 || status === 403 || status === 404)
      return new Error(
        this.identity.channel === 'private'
          ? '비공개 업데이트 연결을 확인해 주세요.'
          : '업데이트를 확인할 수 없습니다. 잠시 후 다시 눌러 주세요.',
      );
    return new Error(`업데이트 서버에 연결할 수 없습니다. (${status})`);
  }

  async verifyAccess(token?: string): Promise<void> {
    if (this.identity.channel === 'private' && !token)
      throw new Error('비공개 업데이트를 먼저 연결해 주세요.');
    const response = await this.request(this.api, {
      headers: this.headers(token),
      redirect: 'error',
    });
    if (!response.ok) throw this.failure(response.status);
    const repository = object(await response.json());
    if (
      typeof repository.full_name !== 'string' ||
      repository.full_name.toLowerCase() !==
        `${this.identity.owner}/${this.identity.repo}`.toLowerCase()
    )
      throw new Error('업데이트 저장소가 일치하지 않습니다.');
  }

  async openAsset(
    asset: GithubAsset,
    token?: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.request(
      `${this.api}/releases/assets/${asset.id}`,
      {
        headers: { ...this.headers(token), Accept: 'application/octet-stream' },
        redirect: 'manual',
        signal,
      },
    );
    if (response.status === 302) {
      const location = response.headers.get('location');
      const url = location ? new URL(location) : null;
      if (
        !url ||
        url.protocol !== 'https:' ||
        !(
          url.hostname === 'githubusercontent.com' ||
          url.hostname.endsWith('.githubusercontent.com')
        ) ||
        url.username ||
        url.password
      )
        throw new Error('업데이트 다운로드 주소를 확인할 수 없습니다.');
      // A signed CDN URL needs no GitHub credential.
      const download = await this.request(url.href, {
        signal,
        redirect: 'error',
      });
      if (!download.ok) throw this.failure(download.status);
      return download;
    }
    if (!response.ok) throw this.failure(response.status);
    return response;
  }

  async check(token?: string): Promise<CheckedUpdate | null> {
    if (this.identity.channel === 'private' && !token)
      throw new Error('비공개 업데이트를 먼저 연결해 주세요.');
    const response = await this.request(`${this.api}/releases/latest`, {
      headers: this.headers(token),
      redirect: 'error',
    });
    if (response.status === 404) {
      await this.verifyAccess(token);
      return null;
    }
    if (!response.ok) throw this.failure(response.status);
    const release = object(await response.json());
    if (
      release.draft !== false ||
      release.prerelease !== false ||
      typeof release.tag_name !== 'string'
    )
      throw new Error('게시된 업데이트 정보를 읽을 수 없습니다.');
    const version = release.tag_name.replace(/^v/, '');
    if (compareReleaseVersions(version, this.identity.version) <= 0)
      return null;
    const available = assets(release.assets);
    const manifests = available.filter(
      (asset) => asset.name === UPDATE_MANIFEST_NAME,
    );
    if (manifests.length !== 1 || manifests[0].size > 1024 * 1024)
      throw new Error('업데이트 파일 목록이 없거나 올바르지 않습니다.');
    const manifestResponse = await this.openAsset(manifests[0], token);
    const bytes = await readManifest(manifestResponse, manifests[0]);
    // Native callers validate payload hashes as well; the manifest is read from
    // the fixed repository over its authenticated release-asset API.
    const manifest = readUpdateManifest(
      JSON.parse(new TextDecoder().decode(bytes)),
      {
        channel: this.identity.channel,
        appId: this.identity.appId,
        version,
      },
    );
    const selected = manifest.assets.find(
      (asset) => asset.kind === this.identity.kind,
    );
    if (!selected) throw new Error('이 기기에 맞는 업데이트 파일이 없습니다.');
    const matches = available.filter((asset) => asset.name === selected.name);
    if (
      matches.length !== 1 ||
      matches[0].size !== selected.size ||
      (matches[0].digest && matches[0].digest !== `sha256:${selected.sha256}`)
    )
      throw new Error('게시된 업데이트 파일과 목록이 일치하지 않습니다.');
    return {
      asset: matches[0],
      release: {
        channel: this.identity.channel,
        version,
        releaseUrl: `https://github.com/${this.identity.owner}/${
          this.identity.repo
        }/releases/tag/${encodeURIComponent(release.tag_name)}`,
        publishedAt:
          typeof release.published_at === 'string' ? release.published_at : '',
        notes: typeof release.body === 'string' ? release.body : '',
        asset: selected,
      },
    };
  }
}
