#!/usr/bin/env node
'use strict';

/**
 * Real production Electron storage/preview acceptance. All data belongs to this
 * run. On Windows CI the profile is on TEMP's C: and selected data on the repo's
 * D: drive. Only the OS directory picker and relaunch process creation are
 * supplied by the fixture; product save, close, boot, IPC and image paths run.
 * Linux: xvfb-run -a node tools/electron-storage-smoke.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { _electron } = require(
  process.env.PLAYWRIGHT_MODULE || 'playwright-core',
);
const { createNativeInput } = require('./electron-native-input.cjs');

const repository = path.resolve(__dirname, '..');
const out = path.resolve(
  process.env.SDSTUDIO_STORAGE_REPORT_DIR ||
    path.join(repository, '.report/storage-smoke'),
);
const packaged = process.env.SDSTUDIO_PACKAGED === '1';
const unavailableOnly = process.env.SDSTUDIO_STORAGE_MODE === 'unavailable';
// A baseline comparison may select an already built immutable app. This only
// changes the fixture's entry/version assertion, never production behavior.
const applicationPath = path.resolve(
  process.env.SDSTUDIO_STORAGE_APP_DIR || path.join(repository, 'release/app'),
);
const expectedVersion =
  process.env.SDSTUDIO_STORAGE_EXPECTED_VERSION ||
  require('../package.json').version;
const profileBase = process.env.SDSTUDIO_STORAGE_PROFILE_BASE || os.tmpdir();
fs.mkdirSync(profileBase, { recursive: true });
const temporaryRoot = fs.mkdtempSync(
  path.join(profileBase, 'sdstudio-storage-profile-'),
);
const userData = path.join(temporaryRoot, 'profile');
const defaultRoot = path.join(userData, 'SDStudio');
fs.mkdirSync(defaultRoot, { recursive: true });
fs.mkdirSync(path.join(repository, '.report'), { recursive: true });
fs.mkdirSync(out, { recursive: true });
const selectedContainer = fs.mkdtempSync(
  path.join(repository, '.report/storage-selected-'),
);
const selectedRoot = path.join(selectedContainer, 'selected-data');
fs.mkdirSync(selectedRoot);
const IMAGE_SIDE = 2048;
const ARTIST_COUNT = 48;
const DETAIL_IMAGES = 8;
const IDLE_SAMPLE_MS = 2000;
const result = {
  status: 'running',
  startedAt: new Date().toISOString(),
  expectedVersion,
  packaged,
  unavailableOnly,
  paths: { userData, defaultRoot, selectedRoot },
  profileFilesExcludedFromDataSnapshot: ['config.json', 'window-state.json'],
  checks: [],
  errors: [],
  blockedRequests: [],
  metrics: {},
};
let application;
let page;
let input;
let phase = 'startup';
let relaunchRequests = 0;
let previewFixture;

function write() {
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
}
async function check(name, action) {
  phase = name;
  const start = Date.now();
  try {
    const detail = await action();
    result.checks.push({
      name,
      status: 'passed',
      durationMs: Date.now() - start,
      detail,
    });
    write();
    process.stdout.write('PASS ' + name + '\n');
    return detail;
  } catch (error) {
    result.checks.push({ name, status: 'failed', error: error.message });
    write();
    throw error;
  }
}
function deadline(promise, milliseconds, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function fileSnapshot(root, omitConfig = false) {
  const files = {};
  function visit(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      // Window geometry belongs to the profile even when user data is on D:.
      // Failed-root checks still include config.json; only geometry is omitted.
      if (root === defaultRoot && relative === 'window-state.json') continue;
      if (omitConfig && relative === 'config.json') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile())
        files[relative] = hash(fs.readFileSync(absolute));
      else
        throw new Error(
          'Unexpected link/special file in owned data fixture: ' + relative,
        );
    }
  }
  visit(root, '');
  return files;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  tag.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([tag, data])), 8 + data.length);
  return output;
}
function pngFactory() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(IMAGE_SIDE, 0);
  header.writeUInt32BE(IMAGE_SIDE, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(IMAGE_SIDE * (IMAGE_SIDE * 4 + 1));
  for (let y = 0; y < IMAGE_SIDE; y += 1) {
    for (let x = 0; x < IMAGE_SIDE; x += 1) {
      const p = y * (IMAGE_SIDE * 4 + 1) + 1 + x * 4;
      pixels[p] = x;
      pixels[p + 1] = y;
      pixels[p + 2] = x ^ y;
      pixels[p + 3] = 255;
    }
  }
  let fixtureIndex = 0;
  return (id) => {
    fixtureIndex += 1;
    // Make decoded pixels distinct as well as file bytes. Metadata alone is
    // removed by sharp's thumbnail encoder and would let identical data URLs
    // share decoded resources, understating the gallery's memory observation.
    for (let y = 0; y < 128; y += 1) {
      for (let x = 0; x < 128; x += 1) {
        const offset = y * (IMAGE_SIDE * 4 + 1) + 1 + x * 4;
        pixels[offset] = (fixtureIndex * 47) & 255;
        pixels[offset + 1] = (fixtureIndex * 83) & 255;
        pixels[offset + 2] = (fixtureIndex * 131) & 255;
      }
    }
    const compressed = zlib.deflateSync(pixels);
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('tEXt', Buffer.from('Fixture\0' + id)),
      chunk('IDAT', compressed),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };
}
function seedArtists() {
  const makePng = pngFactory();
  const artists = [];
  const imageHashes = {};
  const now = Date.now();
  for (let i = 0; i < ARTIST_COUNT; i += 1) {
    const id = 'probe-artist-' + String(i).padStart(2, '0');
    const images = [];
    for (let j = 0; j < (i === 0 ? DETAIL_IMAGES : 1); j += 1) {
      const imageId = id + '-' + j;
      const relative = 'artist_library/' + id + '/' + imageId + '.png';
      const bytes = makePng(imageId);
      fs.mkdirSync(path.dirname(path.join(selectedRoot, relative)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(selectedRoot, relative), bytes);
      imageHashes[relative] = hash(bytes);
      images.push({ id: imageId, path: relative, family: 'v5' });
    }
    artists.push({
      id,
      name: 'Preview fixture ' + String(i).padStart(2, '0'),
      images,
      tags: [],
      favorite: false,
      createdAt: now - i,
      updatedAt: now - i,
    });
  }
  fs.writeFileSync(
    path.join(selectedRoot, 'artist_library.json'),
    JSON.stringify({ version: 1, artists, tagPresets: [] }),
  );
  return { artists, imageHashes, count: Object.keys(imageHashes).length };
}
async function ipc(channel, ...args) {
  return page.evaluate(
    ({ channel, args }) => window.electron.ipcRenderer.invoke(channel, ...args),
    { channel, args },
  );
}
async function frame() {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function launch(blocked = false) {
  const args = ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + userData];
  if (!packaged) args.push(applicationPath);
  application = await _electron.launch({
    executablePath:
      process.env.ELECTRON_EXECUTABLE ||
      require('electron'),
    args,
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60000,
  });
  const child = application.process();
  child.stdout?.on('data', (data) => {
    fs.appendFileSync(path.join(out, 'stdout.log'), data);
    relaunchRequests += (String(data).match(/STORAGE_PROBE_RELAUNCH/g) || [])
      .length;
  });
  child.stderr?.on('data', (data) =>
    fs.appendFileSync(path.join(out, 'stderr.log'), data),
  );
  await application
    .context()
    .route(/https:\/\/[^/]*novelai\.net\//i, (route) => {
      const url = new URL(route.request().url());
      result.blockedRequests.push({
        phase,
        method: route.request().method(),
        path: url.origin + url.pathname,
      });
      return route.abort('blockedbyclient');
    });
  page = await application.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) =>
    result.errors.push({ phase, message: error.message }),
  );
  await page.waitForFunction(
    () => window.electron?.ipcRenderer?.invoke,
    undefined,
    { timeout: 60000 },
  );
  const identity = await application.evaluate(
    async ({ app, BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith('file:'),
      );
      const area = screen.getPrimaryDisplay().workArea;
      win.setMinimumSize(320, 400);
      if (win.isMaximized())
        await new Promise((resolve) => {
          win.once('unmaximize', resolve);
          win.unmaximize();
        });
      win.setContentBounds({
        x: area.x,
        y: area.y,
        width: Math.min(1280, area.width),
        height: Math.min(900, area.height),
      });
      win.show();
      win.focus();
      return {
        version: app.getVersion(),
        electron: process.versions.electron,
        userData: app.getPath('userData'),
        packaged: app.isPackaged,
        platform: process.platform,
        pid: process.pid,
        rendererPid: win.webContents.getOSProcessId(),
        bounds: win.getContentBounds(),
      };
    },
  );
  assert.equal(path.resolve(identity.userData), path.resolve(userData));
  assert.equal(identity.version, expectedVersion);
  assert.equal(identity.packaged, packaged);
  if (!blocked)
    await page.waitForFunction(
      () =>
        window.imageService &&
        document.querySelector('#root .scene-selection-surface'),
      undefined,
      { timeout: 60000 },
    );
  input = await createNativeInput(application, page);
  return identity;
}
async function shutdown() {
  if (!application) return;
  const owned = application;
  application = undefined;
  const child = owned.process();
  if (child.exitCode !== null) return;
  const closed = once(child, 'close');
  try {
    await deadline(
      owned.evaluate(({ app }) => app.exit(0)).catch(() => {}),
      10000,
      'Owned Electron exit did not acknowledge',
    );
    await deadline(closed, 15000, 'Owned Electron process did not exit');
  } catch (error) {
    if (child.exitCode === null) {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5000,
          stdio: 'ignore',
        });
      else child.kill('SIGKILL');
    }
    await deadline(closed, 5000, 'Owned Electron cleanup did not finish');
    throw error;
  }
}
async function metrics() {
  return application.evaluate(async ({ app, BrowserWindow }) => {
    await new Promise((resolve) => setImmediate(resolve));
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('file:'),
    );
    return {
      at: new Date().toISOString(),
      rendererPid: win?.webContents.getOSProcessId(),
      processes: app.getAppMetrics(),
      mainMemory: process.memoryUsage(),
    };
  });
}
async function installIpcObservation() {
  return application.evaluate(({ ipcMain }) => {
    // Observe the pinned Electron runtime's real dispatch table. Every wrapper
    // delegates the original handler unchanged, including failures and results.
    const handlers = ipcMain._invokeHandlers;
    if (!(handlers instanceof Map))
      throw new Error('Pinned Electron IPC observation table unavailable');
    globalThis.__storageObservedIpc = [];
    for (const channel of ['read-data-file', 'resize-image']) {
      const original = handlers.get(channel);
      if (typeof original !== 'function')
        throw new Error('Missing production IPC handler: ' + channel);
      handlers.set(channel, (...args) => {
        globalThis.__storageObservedIpc.push({ channel, argument: args[1] });
        return original(...args);
      });
    }
  });
}
async function observedIpc() {
  return application.evaluate(() => globalThis.__storageObservedIpc || []);
}
async function previewState() {
  return page.locator('[data-image-preview]').evaluateAll((nodes) =>
    nodes.map((element) => {
      const image = element.querySelector('img');
      const rect = element.getBoundingClientRect();
      return {
        path: element.dataset.imagePreview,
        size: element.dataset.previewSize,
        loaded: !!image && image.complete && image.naturalWidth > 0,
        width: image?.naturalWidth || 0,
        height: image?.naturalHeight || 0,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < innerHeight &&
          rect.right > 0 &&
          rect.left < innerWidth,
      };
    }),
  );
}
async function exercisePreviews() {
  await installIpcObservation();
  // The saved fixture project is not selected by sessionService.add(). Main
  // tabs are mounted only after a project is opened through the actual drawer.
  await input.click(
    page
      .getByRole('button', {
        // Tooltip supplies this aria-label to SessionSelect's drawer button.
        name: '프로젝트 목록 열기 (폴더 드로어)',
        exact: true,
      })
      .filter({ visible: true }),
  );
  // A fresh drawer expands favorites only. The one owned project is under
  // its initially collapsed unfiled section, whose header is a real button.
  const unfiledSection = page
    .locator('[data-drop-unfiled="1"]')
    .filter({ visible: true });
  const unfiledToggle = unfiledSection.locator(':scope > button');
  await unfiledToggle.waitFor({ state: 'visible' });
  assert.equal(
    (await unfiledToggle.innerText()).replace(/\s+/g, ''),
    '미분류1',
    'The fresh fixture must expose its single project in the unfiled folder',
  );
  await input.click(unfiledToggle);
  const projectChoice = unfiledSection
    .getByRole('button', {
      name: `${result.project.name} 프로젝트 선택`,
      exact: true,
    })
    .filter({ visible: true });
  await projectChoice.waitFor({ state: 'visible' });
  await input.click(projectChoice);
  await projectChoice.waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: '작가 라이브러리', exact: true })
    .filter({ visible: true })
    .waitFor({ state: 'visible' });
  // A fresh project shows scene shortcut help. At 1024px it covers the artist
  // tab; close that real onboarding panel before sending the native tab click.
  const sceneHelp = page
    .locator('div.r-modal')
    .filter({
      has: page.locator('span.font-bold').filter({
        hasText: /^단축키 도움말$/,
      }),
    })
    .filter({ visible: true });
  await sceneHelp.waitFor({ state: 'visible' });
  await input.click(
    sceneHelp.getByRole('button', { name: '닫기', exact: true }),
  );
  await sceneHelp.waitFor({ state: 'hidden' });
  result.metrics.beforeGallery = await metrics();
  await input.click(
    page
      .getByRole('button', { name: '작가 라이브러리', exact: true })
      .filter({ visible: true }),
  );
  await page
    .getByPlaceholder('작가 이름 · 태그로 검색…', { exact: true })
    .waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-image-preview] img')].some(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  await frame();
  const first = await previewState();
  assert.equal(first.length, ARTIST_COUNT);
  const loaded = first.filter((p) => p.loaded);
  assert(
    loaded.length > 0 && loaded.length < ARTIST_COUNT,
    'A gallery must load visible previews without loading every original',
  );
  const requestedThumbnailSize = 400;
  // ImageService.resizeImage uses a 1.1 scale above 200px on desktop.
  // Preserve its exact Math.ceil behavior: 400 * 1.1 rounds up to 441.
  const actualPixelBound = Math.ceil(requestedThumbnailSize * 1.1);
  assert(
    loaded.every(
      (p) =>
        p.size === String(requestedThumbnailSize) &&
        p.width <= actualPixelBound &&
        p.height <= actualPixelBound,
    ),
    'Cards must use the requested small decoded previews',
  );
  const firstCalls = await observedIpc();
  // getSmallImagePath keeps the source directory and inserts /fastcache/.
  // Match owned original paths exactly so valid thumbnail reads are distinct.
  const originalPaths = new Set(Object.keys(previewFixture.imageHashes));
  assert(
    !firstCalls.some(
      (call) =>
        call.channel === 'read-data-file' &&
        originalPaths.has(String(call.argument)),
    ),
    'Opening the card grid read an original into the renderer',
  );
  const last = page.getByRole('button', {
    name: 'Preview fixture 47 보기',
    exact: true,
  });
  await last.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const preview = document.querySelector(
      '[data-image-preview="artist_library/probe-artist-47/probe-artist-47-0.png"] img',
    );
    return preview?.complete && preview.naturalWidth > 0;
  });
  await frame();
  const bottom = await previewState();
  assert.equal(
    bottom.find((p) => p.path === previewFixture.artists[0].images[0].path)
      .loaded,
    false,
    'Scrolling a card away must release its decoded image',
  );
  const firstCard = page.getByRole('button', {
    name: 'Preview fixture 00 보기',
    exact: true,
  });
  await firstCard.scrollIntoViewIfNeeded();
  await input.click(firstCard);
  const modal = page.getByRole('dialog', {
    name: 'Preview fixture 00',
    exact: true,
  });
  await modal.waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"] img')].some(
      (image) => image.complete && image.naturalWidth === 2048,
    ),
  );
  const original = await modal.locator('img').evaluateAll((images) =>
    images
      .filter((image) => image.complete)
      .map((image) => ({
        width: image.naturalWidth,
        height: image.naturalHeight,
      })),
  );
  assert(
    original.some(
      (image) => image.width === IMAGE_SIDE && image.height === IMAGE_SIDE,
    ),
    'Selecting a detail must retain full original resolution',
  );
  await page.screenshot({ path: path.join(out, 'artist-detail.png') });
  await input.click(modal.getByRole('button', { name: '닫기', exact: true }));
  await modal.waitFor({ state: 'hidden' });
  const activeCount = (await previewState()).filter((p) => p.loaded).length;
  assert(activeCount < ARTIST_COUNT);
  // Cycle the actual tab away and back; the component lifecycle owns release.
  await input.click(
    page
      .getByRole('button', { name: '이미지변형', exact: true })
      .filter({ visible: true }),
  );
  await frame();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-image-preview] img').length === 0,
  );
  result.metrics.afterGalleryHidden = await metrics();
  await input.click(
    page
      .getByRole('button', { name: '작가 라이브러리', exact: true })
      .filter({ visible: true }),
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-image-preview] img')].some(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  const calls = await observedIpc();
  for (const [relative, expected] of Object.entries(previewFixture.imageHashes))
    assert.equal(
      hash(fs.readFileSync(path.join(selectedRoot, relative))),
      expected,
      'Previewing modified an original',
    );
  result.metrics.afterGalleryCycle = await metrics();
  await page.screenshot({ path: path.join(out, 'artist-gallery.png') });
  return {
    originals: previewFixture.count,
    originalResolution: IMAGE_SIDE,
    requestedThumbnailSize,
    actualPixelBound,
    initialLoadedCards: loaded.length,
    totalCards: ARTIST_COUNT,
    afterScrollLoadedCards: bottom.filter((p) => p.loaded).length,
    fullResolutionDetail: original,
    calls,
  };
}
async function nativeRootChange() {
  await application.evaluate(({ app, dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
    // The production close/save path still runs. The driver owns the replacement
    // process so that test failure cannot leave an unmanaged app relaunch alive.
    app.relaunch = () => process.stdout.write('STORAGE_PROBE_RELAUNCH\n');
  }, selectedRoot);
  await input.click(
    page
      .getByRole('button', { name: '환경설정', exact: true })
      .filter({ visible: true }),
  );
  const panel = page.getByRole('dialog', { name: '환경설정', exact: true });
  await panel.waitFor({ state: 'visible' });
  await input.click(
    panel.getByRole('button', { name: '저장경로', exact: true }),
  );
  await page.screenshot({ path: path.join(out, 'storage-before-change.png') });
  await input.click(
    panel.getByRole('button', {
      name: '이미지 및 데이터 저장 위치 변경',
      exact: true,
    }),
  );
  const confirm = page.getByRole('button', {
    name: '이 위치로 바꾸고 다시 시작',
    exact: true,
  });
  await confirm.waitFor({ state: 'visible' });
  await page.screenshot({
    path: path.join(out, 'storage-change-confirmation.png'),
  });
  const child = application.process();
  const closed = once(child, 'close');
  let inputError;
  try {
    await input.click(confirm);
  } catch (error) {
    inputError = error;
  }
  await deadline(
    closed,
    30000,
    'Changing storage did not finish the real save/close/restart path',
  );
  application = undefined;
  assert.equal(child.exitCode, 0, 'Storage switch exited with an error');
  assert.equal(
    relaunchRequests,
    1,
    'Storage UI must request exactly one relaunch',
  );
  // Native Windows input may observe the expected window destruction after its
  // final click. Accept only that proved close, never a click on a live app.
  if (inputError) result.finalClickClosedWindow = inputError.message;
  const persisted = JSON.parse(
    fs.readFileSync(path.join(defaultRoot, 'config.json'), 'utf8'),
  );
  assert.equal(
    path.resolve(persisted.saveLocation),
    path.resolve(selectedRoot),
  );
  return {
    saveLocation: persisted.saveLocation,
    relaunchRequests,
    nativeClose: true,
  };
}
async function verifyUnavailableRoot() {
  await shutdown();
  const preserved = selectedRoot + '-preserved';
  fs.renameSync(selectedRoot, preserved);
  fs.writeFileSync(
    selectedRoot,
    'An ordinary file models an unavailable configured directory.',
  );
  const beforeDefault = fileSnapshot(defaultRoot);
  const beforeSelected = fileSnapshot(preserved);
  try {
    const identity = await launch(true);
    const warnings = await ipc('get-boot-warnings');
    const actualRoot = await ipc('get-data-root');
    assert.equal(
      path.resolve(actualRoot),
      path.resolve(selectedRoot),
      'Unavailable custom root silently fell back to the default profile',
    );
    assert.equal(
      path.resolve(warnings.saveLocationFallback.attempted),
      path.resolve(selectedRoot),
    );
    await page
      .getByText('저장 폴더에 접근할 수 없습니다', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(
      await page
        .getByRole('button', { name: '기본 위치로 계속 (임시)', exact: true })
        .count(),
      0,
    );
    const attempts = [
      ['write-file', 'workspace/rejected.txt', 'must never land on C'],
      [
        'write-data-file',
        'outs/rejected.png',
        Buffer.from('rejected').toString('base64'),
      ],
      ['read-file', 'artist_library.json'],
      ['list-files', 'workspace'],
    ];
    const rejected = [];
    for (const [channel, ...args] of attempts) {
      const outcome = await ipc(channel, ...args).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, message: error.message }),
      );
      assert.equal(
        outcome.ok,
        false,
        'Unavailable-root IPC was allowed: ' + channel,
      );
      rejected.push({ channel, error: outcome.message });
    }
    await frame();
    assert.deepEqual(
      fileSnapshot(defaultRoot),
      beforeDefault,
      'Unavailable custom storage changed default data/config files',
    );
    assert.deepEqual(
      fileSnapshot(preserved),
      beforeSelected,
      'Unavailable boot modified the preserved selected data',
    );
    await page.screenshot({ path: path.join(out, 'unavailable-storage.png') });
    return {
      identity,
      warning: warnings.saveLocationFallback,
      actualRoot,
      rejected,
      defaultRootUnchanged: true,
      selectedDataUnchanged: true,
    };
  } finally {
    await shutdown();
    fs.unlinkSync(selectedRoot);
    fs.renameSync(preserved, selectedRoot);
  }
}
async function main() {
  if (process.platform === 'win32') {
    const from = path.parse(defaultRoot).root.toUpperCase();
    const to = path.parse(selectedRoot).root.toUpperCase();
    result.drives = { profile: from, selected: to };
    if (process.env.GITHUB_ACTIONS === 'true') {
      assert.equal(from, 'C:\\', 'Windows CI profile fixture must exercise C:');
      assert.equal(to, 'D:\\', 'Windows CI chosen folder must exercise D:');
    }
  }
  if (unavailableOnly) {
    fs.writeFileSync(
      path.join(defaultRoot, 'config.json'),
      JSON.stringify({ saveLocation: selectedRoot }),
    );
    await check(
      'unavailable configured root never falls back or initializes default data',
      verifyUnavailableRoot,
    );
    result.status = 'passed';
    return;
  }
  previewFixture = seedArtists();
  result.identity = await check(
    'isolated production startup and exact app identity',
    launch,
  );
  assert.equal(
    path.resolve(await ipc('get-data-root')),
    path.resolve(defaultRoot),
  );
  const sentinel = 'Old-root bytes must remain where the owner left them.';
  await ipc('write-file', 'storage-acceptance-old.txt', sentinel);
  await check(
    'native preferences selection saves and closes for restart',
    nativeRootChange,
  );
  const defaultAfterSwitch = fileSnapshot(defaultRoot, true);
  result.selectedIdentity = await check(
    'full process restart activates the selected root',
    async () => {
      const identity = await launch();
      assert.notEqual(identity.pid, result.identity.pid);
      assert.equal(
        path.resolve(await ipc('get-data-root')),
        path.resolve(selectedRoot),
      );
      assert.equal(
        fs.readFileSync(
          path.join(defaultRoot, 'storage-acceptance-old.txt'),
          'utf8',
        ),
        sentinel,
      );
      return identity;
    },
  );
  await check(
    'project image backup cache and temporary bytes use the selected root',
    async () => {
      const imagePath = previewFixture.artists[0].images[0].path;
      const bytes = fs.readFileSync(path.join(selectedRoot, imagePath));
      await ipc(
        'write-data-file',
        'outs/storage-acceptance/output.png',
        bytes.toString('base64'),
      );
      await ipc(
        'write-file',
        'tmp/storage-acceptance.txt',
        'temporary selected-root content',
      );
      await ipc('resize-image', {
        inputPath: imagePath,
        outputPath: 'fastcache/storage-acceptance.png',
        maxWidth: 200,
        maxHeight: 200,
      });
      await ipc(
        'zip-files',
        [{ name: 'evidence.png', path: 'outs/storage-acceptance/output.png' }],
        'backups/storage-acceptance.zip',
      );
      const savedProject = await page.evaluate(async () => {
        const service = window.sessionService;
        const name = 'Storage acceptance project';
        await service.add(name);
        const session = await service.get(name);
        session.extraPrompt = 'selected-root durable prompt';
        service.markDirty(name);
        await service.flushProjectNow(name);
        return { path: service.getPath(name), name };
      });
      assert.deepEqual(
        fs.readFileSync(
          path.join(selectedRoot, 'outs/storage-acceptance/output.png'),
        ),
        bytes,
      );
      assert.equal(
        fs.readFileSync(
          path.join(selectedRoot, 'tmp/storage-acceptance.txt'),
          'utf8',
        ),
        'temporary selected-root content',
      );
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(selectedRoot, savedProject.path), 'utf8'),
        ).extraPrompt,
        'selected-root durable prompt',
      );
      const Zip = require('adm-zip');
      assert.deepEqual(
        new Zip(
          path.join(selectedRoot, 'backups/storage-acceptance.zip'),
        ).readFile('evidence.png'),
        bytes,
      );
      assert(
        fs.statSync(path.join(selectedRoot, 'fastcache/storage-acceptance.png'))
          .size > 0,
      );
      assert.deepEqual(fileSnapshot(defaultRoot, true), defaultAfterSwitch);
      result.project = savedProject;
      return {
        savedProject,
        imageSha256: hash(bytes),
        backupBytes: fs.statSync(
          path.join(selectedRoot, 'backups/storage-acceptance.zip'),
        ).size,
        defaultDataUnchanged: true,
      };
    },
  );
  await check(
    'visible gallery thumbnails release while detail retains original quality',
    exercisePreviews,
  );
  await check('idle CPU and memory observations', async () => {
    const first = await metrics();
    await page.waitForTimeout(IDLE_SAMPLE_MS);
    const second = await metrics();
    result.metrics.idle = { sampleIntervalMs: IDLE_SAMPLE_MS, first, second };
    return result.metrics.idle;
  });
  await check(
    'saved values survive another complete process restart',
    async () => {
      await shutdown();
      const identity = await launch();
      assert.equal(
        path.resolve(await ipc('get-data-root')),
        path.resolve(selectedRoot),
      );
      assert.equal(
        await ipc('read-file', 'tmp/storage-acceptance.txt'),
        'temporary selected-root content',
      );
      const project = JSON.parse(await ipc('read-file', result.project.path));
      assert.equal(project.extraPrompt, 'selected-root durable prompt');
      assert.deepEqual(fileSnapshot(defaultRoot, true), defaultAfterSwitch);
      return {
        identity,
        retainedPrompt: project.extraPrompt,
        defaultDataUnchanged: true,
      };
    },
  );
  await check(
    'unavailable configured root never falls back or initializes default data',
    verifyUnavailableRoot,
  );
  await check('restored directory reopens the same selected data', async () => {
    await launch();
    assert.equal(
      path.resolve(await ipc('get-data-root')),
      path.resolve(selectedRoot),
    );
    assert.equal(
      JSON.parse(await ipc('read-file', result.project.path)).extraPrompt,
      'selected-root durable prompt',
    );
    assert.deepEqual(fileSnapshot(defaultRoot, true), defaultAfterSwitch);
    return { selectedRoot, recovered: true };
  });
  assert.equal(
    result.errors.length,
    0,
    'Uncaught renderer errors were observed',
  );
  assert.equal(
    result.blockedRequests.filter((request) => request.method !== 'GET').length,
    0,
    'Fixture attempted a paid provider request',
  );
  result.status = 'passed';
}
main()
  .catch(async (error) => {
    result.status = 'failed';
    result.error = { message: error.message, stack: error.stack, phase };
    if (page && !page.isClosed()) {
      await page
        .screenshot({ path: path.join(out, 'failure.png'), timeout: 10000 })
        .catch(() => {});
      const visible = await page
        .evaluate(() => document.body.innerText)
        .catch(() => '');
      fs.writeFileSync(path.join(out, 'failure-visible.txt'), visible);
      const controls = await page
        .evaluate(() => {
          const nodes = Array.from(
            document.querySelectorAll(
              'button, [role="button"], [role="tab"], [role="dialog"]',
            ),
          );
          return {
            totalMatches: nodes.length,
            controls: nodes.slice(0, 400).map((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const labelledBy = element.getAttribute('aria-labelledby');
              return {
                tag: element.tagName.toLowerCase(),
                role:
                  element.getAttribute('role') ||
                  (element.tagName === 'BUTTON' ? 'button' : null),
                id: element.id,
                ariaLabel: element.getAttribute('aria-label'),
                ariaLabelledby: labelledBy,
                labelledByText: (labelledBy || '')
                  .split(/\s+/)
                  .filter(Boolean)
                  .map((id) => document.getElementById(id)?.textContent || '')
                  .join(' ')
                  .trim()
                  .slice(0, 240),
                title: element.getAttribute('title'),
                text: (element.textContent || '').trim().slice(0, 240),
                disabled: element.hasAttribute('disabled'),
                ariaHidden: element.getAttribute('aria-hidden'),
                visible:
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden',
                bounds: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
              };
            }),
          };
        })
        .catch((captureError) => ({ captureError: captureError.message }));
      fs.writeFileSync(
        path.join(out, 'failure-controls.json'),
        JSON.stringify(controls, null, 2) + '\n',
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await shutdown();
    } catch (error) {
      result.cleanupError = error.message;
      result.status = 'failed';
      process.exitCode = 1;
    } finally {
      result.finishedAt = new Date().toISOString();
      write();
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      fs.rmSync(selectedContainer, { recursive: true, force: true });
      process.stdout.write(
        'Storage result: ' + path.join(out, 'result.json') + '\n',
      );
    }
  });
