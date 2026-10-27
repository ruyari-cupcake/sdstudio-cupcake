/** @jest-environment node */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { DesktopReleaseUpdater } from '../desktopReleaseUpdater';
import {
  GithubReleaseClient,
  type GithubUpdateIdentity,
} from '../githubRelease';
import { UPDATE_SNOOZE_MS, type UpdateProgress } from '../../shared/appUpdate';

const bytes = Buffer.from('a complete package fixture');
const sha256 = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
const identity: GithubUpdateIdentity = {
  owner: 'example',
  repo: 'private-studio',
  channel: 'private',
  appId: 'io.example.private',
  version: '6.0.0-cupcake.6',
  kind: 'windows-folder',
};
function fixture(channel = identity.channel, appId = identity.appId) {
  const assets = [
    {
      kind: 'windows-portable',
      name: 'Studio.exe',
      size: bytes.length,
      sha256,
    },
    { kind: 'windows-folder', name: 'Studio.zip', size: bytes.length, sha256 },
    { kind: 'android-apk', name: 'Studio.apk', size: bytes.length, sha256 },
  ];
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 1,
      channel,
      appId,
      version: '6.1.0-cupcake.1',
      assets,
    }),
  );
  return {
    manifest,
    release: {
      draft: false,
      prerelease: false,
      tag_name: 'v6.1.0-cupcake.1',
      published_at: '2026-10-27T00:00:00Z',
      body: 'A release',
      assets: [
        {
          id: 1,
          name: 'update-manifest.json',
          size: manifest.length,
          digest: `sha256:${createHash('sha256')
            .update(new Uint8Array(manifest))
            .digest('hex')}`,
        },
        ...assets.map((asset, index) => ({
          id: index + 2,
          name: asset.name,
          size: asset.size,
          digest: `sha256:${sha256}`,
        })),
      ],
    },
  };
}
function server(
  change?: (
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined,
) {
  const data = fixture();
  return jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const override = change?.(url, init);
    if (override) return override;
    if (url.endsWith('/releases/latest')) return Response.json(data.release);
    if (url.endsWith('/releases/assets/1'))
      return new Response(new Uint8Array(data.manifest));
    if (/\/releases\/assets\/[234]$/.test(url))
      return new Response(new Uint8Array(bytes));
    if (url === 'https://api.github.com/repos/example/private-studio')
      return Response.json({ full_name: 'example/private-studio' });
    throw new Error(`Unexpected URL: ${url}`);
  }) as jest.MockedFunction<typeof fetch>;
}

describe('fixed repository release transport', () => {
  test('private calls only its build repository and sends credentials only to GitHub API', async () => {
    const request = server((url) =>
      url.endsWith('/releases/assets/3')
        ? new Response(null, {
            status: 302,
            headers: {
              location:
                'https://release-assets.githubusercontent.com/file?signature=fixture',
            },
          })
        : url.startsWith('https://release-assets.githubusercontent.com/')
          ? new Response(new Uint8Array(bytes))
          : undefined,
    );
    const client = new GithubReleaseClient(identity, request);
    const checked = await client.check('test-token');
    expect(checked?.release.channel).toBe('private');
    await client.openAsset(checked!.asset, 'test-token');
    expect(
      request.mock.calls.map(([url, options]) => ({
        url: String(url),
        authorization: new Headers(options?.headers).get('Authorization'),
      })),
    ).toEqual([
      {
        url: 'https://api.github.com/repos/example/private-studio/releases/latest',
        authorization: 'Bearer test-token',
      },
      {
        url: 'https://api.github.com/repos/example/private-studio/releases/assets/1',
        authorization: 'Bearer test-token',
      },
      {
        url: 'https://api.github.com/repos/example/private-studio/releases/assets/3',
        authorization: 'Bearer test-token',
      },
      {
        url: 'https://release-assets.githubusercontent.com/file?signature=fixture',
        authorization: null,
      },
    ]);
  });

  test('public calls carry no private credential even if one is supplied', async () => {
    const data = fixture('public', 'io.example.public');
    const request = server((url) => {
      if (url.endsWith('/releases/latest')) return Response.json(data.release);
      if (url.endsWith('/releases/assets/1'))
        return new Response(new Uint8Array(data.manifest));
      return undefined;
    });
    const client = new GithubReleaseClient(
      { ...identity, channel: 'public', appId: 'io.example.public' },
      request,
    );
    expect((await client.check('should-never-send'))?.release.channel).toBe(
      'public',
    );
    expect(
      request.mock.calls.every(
        ([, init]) => !new Headers(init?.headers).has('Authorization'),
      ),
    ).toBe(true);
  });

  test('no private credential means no network call', async () => {
    const request = server();
    await expect(
      new GithubReleaseClient(identity, request).check(),
    ).rejects.toThrow('연결');
    expect(request).not.toHaveBeenCalled();
  });

  test('wrong channel metadata and untrusted CDN redirects are rejected', async () => {
    const wrong = fixture('public');
    const request = server((url) =>
      url.endsWith('/releases/assets/1')
        ? new Response(new Uint8Array(wrong.manifest))
        : undefined,
    );
    await expect(
      new GithubReleaseClient(identity, request).check('test-token'),
    ).rejects.toThrow();
    const redirect = server(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.invalid/file' },
        }),
    );
    await expect(
      new GithubReleaseClient(identity, redirect).openAsset(
        { id: 3, name: 'file', size: 1 },
        'test-token',
      ),
    ).rejects.toThrow('주소');
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  test('missing latest release distinguishes no release from revoked repository access', async () => {
    const empty = server((url) =>
      url.endsWith('/releases/latest')
        ? new Response(null, { status: 404 })
        : undefined,
    );
    await expect(
      new GithubReleaseClient(identity, empty).check('test-token'),
    ).resolves.toBeNull();
    const revoked = server(() => new Response(null, { status: 404 }));
    await expect(
      new GithubReleaseClient(identity, revoked).check('test-token'),
    ).rejects.toThrow('연결');
    expect(revoked).toHaveBeenCalledTimes(2);
  });

  test('release asset digest must agree with the manifest', async () => {
    const data = fixture();
    data.release.assets[2].digest = `sha256:${'0'.repeat(64)}`;
    const request = server((url) =>
      url.endsWith('/releases/latest')
        ? Response.json(data.release)
        : undefined,
    );
    await expect(
      new GithubReleaseClient(identity, request).check('test-token'),
    ).rejects.toThrow('일치');
  });

  test('manifest bytes must agree with the published asset digest', async () => {
    const data = fixture();
    data.release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    const request = server((url) =>
      url.endsWith('/releases/latest')
        ? Response.json(data.release)
        : undefined,
    );
    await expect(
      new GithubReleaseClient(identity, request).check('test-token'),
    ).rejects.toThrow('일치');
  });

  test('an oversized manifest stops reading and cancels the response body', async () => {
    const cancel = jest.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(fixture().manifest.length + 1));
          if (pulls === 4) controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const request = server((url) =>
      url.endsWith('/releases/assets/1') ? new Response(body) : undefined,
    );
    await expect(
      new GithubReleaseClient(identity, request).check('test-token'),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBe(1);
  });
});

describe('desktop update state and selected-root download', () => {
  let root: string;
  let profile: string;
  let dataRoot: string;
  let events: UpdateProgress[];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-update-test-'));
    profile = path.join(root, 'profile');
    dataRoot = path.join(root, 'selected-data');
    events = [];
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  function updater(request = server(), now = 1000) {
    return new DesktopReleaseUpdater({
      identity,
      profileRoot: profile,
      getDataRoot: () => dataRoot,
      supported: true,
      encryptToken: () => 'encrypted-fixture',
      decryptToken: (value) => {
        if (value !== 'encrypted-fixture') throw new Error('bad cipher');
        return 'test-token';
      },
      onProgress: (progress) => events.push(progress),
      request,
      now: () => now,
    });
  }

  test('token stays encrypted on disk and state never returns it; snooze survives restart', async () => {
    const service = updater();
    await service.connect('test-token');
    await service.snooze();
    const state = await updater().getState();
    expect(state).toEqual({
      channel: 'private',
      version: identity.version,
      supported: true,
      connected: true,
      snoozedUntil: 1000 + UPDATE_SNOOZE_MS,
    });
    const persisted = await fs.readFile(
      path.join(profile, 'app-update-private.json'),
      'utf8',
    );
    expect(persisted).toContain('encrypted-fixture');
    expect(persisted).not.toContain('test-token');
    expect(JSON.stringify(state)).not.toContain('encrypted-fixture');
    await service.disconnect();
    expect((await updater().getState()).connected).toBe(false);
  });

  test('startup claim is shared by all callers during one app lifetime', async () => {
    const service = updater();
    expect(
      await Promise.all([
        service.claimStartupCheck(),
        service.claimStartupCheck(),
      ]),
    ).toEqual([true, false]);
    expect(await updater().claimStartupCheck()).toBe(true);
  });

  test('concurrent checks and downloads are single-flight and publish only a complete verified file', async () => {
    const request = server();
    const service = updater(request);
    await service.connect('test-token');
    const [first, second] = await Promise.all([
      service.check(),
      service.check(),
    ]);
    expect(first).toEqual(second);
    expect(
      request.mock.calls.filter(([url]) =>
        String(url).endsWith('/releases/latest'),
      ),
    ).toHaveLength(1);
    await Promise.all([
      service.download(first!.version),
      service.download(first!.version),
    ]);
    const downloaded = service.getDownloaded();
    expect(downloaded.artifactPath).toBe(
      path.join(dataRoot, '.updates/private/download/Studio.zip'),
    );
    expect(await fs.readFile(downloaded.artifactPath)).toEqual(bytes);
    expect(
      request.mock.calls.filter(([url]) =>
        String(url).endsWith('/releases/assets/3'),
      ),
    ).toHaveLength(1);
    expect(events.at(-1)?.phase).toBe('ready');
    expect(
      await fs.readdir(path.join(dataRoot, '.updates/private/download')),
    ).toEqual(['Studio.zip']);
  });

  test.each(['truncated', 'corrupt', 'oversized'])(
    'a %s transfer removes partial output and cannot install',
    async (kind) => {
      const bad =
        kind === 'truncated'
          ? bytes.subarray(0, 4)
          : kind === 'oversized'
            ? Buffer.concat([new Uint8Array(bytes), new Uint8Array(bytes)])
            : Buffer.alloc(bytes.length, 1);
      const request = server((url) =>
        url.endsWith('/releases/assets/3')
          ? new Response(new Uint8Array(bad))
          : undefined,
      );
      const service = updater(request);
      await service.connect('test-token');
      const release = await service.check();
      await expect(service.download(release!.version)).rejects.toThrow();
      expect(() => service.getDownloaded()).toThrow();
      await expect(
        fs.stat(path.join(dataRoot, '.updates/private/download')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(events.some((event) => event.phase === 'ready')).toBe(false);
    },
  );

  test('explicit cancellation settles the download and clears its own partial files', async () => {
    let service: DesktopReleaseUpdater;
    const request = server((url, init) =>
      url.endsWith('/releases/assets/3')
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
            queueMicrotask(() => {
              void service.cancelDownload();
            });
          })
        : undefined,
    );
    service = updater(request);
    await service.connect('test-token');
    const release = await service.check();
    await expect(service.download(release!.version)).rejects.toThrow('취소');
    expect(service.isDownloading).toBe(false);
    expect(() => service.getDownloaded()).toThrow();
  });

  test('a storage transition prevents installation of a download from the old root', async () => {
    const service = updater();
    await service.connect('test-token');
    const release = await service.check();
    await service.download(release!.version);
    dataRoot = path.join(root, 'different-data');
    expect(() => service.getDownloaded()).toThrow('저장 위치');
  });
});
