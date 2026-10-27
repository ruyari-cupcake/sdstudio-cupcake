#!/usr/bin/env node
'use strict';

/**
 * Production Electron smoke using an isolated temporary profile and generated PNGs.
 * This script never sends a paid request. Its finite action deadlines are test
 * diagnostics only; no application timeout or generation policy is changed.
 *
 * ELECTRON_EXECUTABLE=/path/to/electron PLAYWRIGHT_MODULE=/path/to/playwright
 *   xvfb-run -a node tools/electron-smoke.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const verifyTitlebar = require('./electron-titlebar-smoke.cjs');

const repository = path.resolve(
  process.env.SDSTUDIO_REPO || path.join(__dirname, '..'),
);
const applicationPath = path.resolve(
  process.env.SDSTUDIO_APP_PATH || path.join(repository, 'release/app'),
);
const executablePath = process.env.ELECTRON_EXECUTABLE;
assert(
  executablePath,
  'Set ELECTRON_EXECUTABLE to the verified Electron runtime',
);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDirectory = path.resolve(
  process.env.SDSTUDIO_SMOKE_REPORT_DIR ||
    path.join(repository, '.report', `electron-smoke-${stamp}`),
);
fs.mkdirSync(reportDirectory, { recursive: true });
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'cupcake-sdstudio-smoke-'),
);
const userData = path.join(temporaryRoot, 'profile');
fs.mkdirSync(userData);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(repository, 'package.json'), 'utf8'),
);
const modelSource = fs.readFileSync(
  path.join(repository, 'src/renderer/backends/imageGen.ts'),
  'utf8',
);
const modelEnum = /export enum ModelVersion\s*\{([\s\S]*?)\}/.exec(modelSource);
const modelValue =
  modelEnum && /\bV5\s*=\s*['"]([^'"]+)['"]/.exec(modelEnum[1]);
assert(modelValue, 'Cannot resolve the repository V5 enum value');
const modelVersion = modelValue[1];

const result = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  applicationPath,
  executablePath,
  isolatedUserData: userData,
  reportDirectory,
  checks: [],
  pageErrors: [],
  consoleErrors: [],
  blockedNovelAiRequests: [],
  metrics: {},
};
let ownedApp;
let page;
let phase = 'startup';

function saveResult() {
  fs.writeFileSync(
    path.join(reportDirectory, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
}
function deadline(promise, milliseconds, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Test action exceeded ${milliseconds}ms: ${description}`),
          ),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
async function check(name, action) {
  phase = name;
  const started = Date.now();
  try {
    const detail = await action();
    result.checks.push({
      name,
      status: 'passed',
      durationMs: Date.now() - started,
      detail,
    });
    saveResult();
    process.stdout.write(`PASS ${name}\n`);
    return detail;
  } catch (error) {
    result.checks.push({
      name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: { message: String(error.message || error), stack: error.stack },
    });
    saveResult();
    throw error;
  }
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
function pngChunk(type, data) {
  const tag = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  tag.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([tag, data])), 8 + data.length);
  return chunk;
}
function fixturePng(width = 256, height = 256) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      pixels[offset] = x;
      pixels[offset + 1] = y;
      pixels[offset + 2] = x ^ y;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function launch() {
  const application = await _electron.launch({
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${userData}`,
      applicationPath,
    ],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60_000,
  });
  ownedApp = application;
  const child = application.process();
  for (const [stream, filename] of [
    [child.stdout, 'stdout.log'],
    [child.stderr, 'stderr.log'],
  ]) {
    stream?.on('data', (data) =>
      fs.appendFileSync(path.join(reportDirectory, filename), data),
    );
  }
  await application
    .context()
    .route(/https:\/\/[^/]*novelai\.net\//i, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      result.blockedNovelAiRequests.push({
        phase,
        method: request.method(),
        url: url.origin + url.pathname,
      });
      await route.abort('blockedbyclient');
    });
  const windowPage = await application.firstWindow({ timeout: 60_000 });
  page = windowPage;
  windowPage.setDefaultTimeout(30_000);
  windowPage.on('pageerror', (error) =>
    result.pageErrors.push({
      phase,
      message: error.message,
      stack: error.stack,
    }),
  );
  windowPage.on('console', (message) => {
    if (message.type() === 'error')
      result.consoleErrors.push({ phase, text: message.text() });
  });
  await ready(windowPage);
  return windowPage;
}
async function ready(windowPage = page) {
  try {
    await windowPage.waitForFunction(
      () => {
        // App.tsx mounts this real application surface only after bootReady.
        // A root containing the startup spinner is not a usable application.
        const surface = document.querySelector(
          '#root .scene-selection-surface',
        );
        return !!(
          window.electron?.ipcRenderer?.invoke &&
          window.imageService &&
          surface &&
          surface.getBoundingClientRect().width > 0 &&
          surface.getBoundingClientRect().height > 0
        );
      },
      undefined,
      { timeout: 60_000 },
    );
  } catch (error) {
    result.bootstrapFailure = await windowPage
      .evaluate(() => ({
        text: document.body.innerText.slice(0, 1600),
        hasPreload: !!window.electron?.ipcRenderer?.invoke,
        hasImageService: !!window.imageService,
        hasApplicationSurface: !!document.querySelector(
          '#root .scene-selection-surface',
        ),
      }))
      .catch(() => ({ rendererUnavailable: true }));
    await windowPage
      .screenshot({ path: path.join(reportDirectory, 'bootstrap-failure.png') })
      .catch(() => {});
    throw error;
  }
}
async function ipc(channel, ...args) {
  return page.evaluate(
    ({ channel, args }) => window.electron.ipcRenderer.invoke(channel, ...args),
    { channel, args },
  );
}
async function mainSnapshot() {
  return ownedApp.evaluate(async ({ app }) => {
    // One event-loop turn lets completed native close operations leave active handles.
    await new Promise((resolve) => setImmediate(resolve));
    const handles = {};
    for (const handle of process._getActiveHandles()) {
      const name = handle?.constructor?.name || 'Unknown';
      handles[name] = (handles[name] || 0) + 1;
    }
    return {
      handles,
      fsWatchers: handles.FSWatcher || 0,
      memory: process.memoryUsage(),
      resourceUsage: process.resourceUsage(),
      processes: app.getAppMetrics(),
    };
  });
}
async function shutdown() {
  const application = ownedApp;
  if (!application) return;
  ownedApp = undefined;
  const child = application.process();
  if (child.exitCode !== null) return;
  const closed = once(child, 'close');
  await deadline(
    application.evaluate(({ app }) => app.exit(0)).catch(() => {}),
    10_000,
    'exit the isolated Electron application',
  ).catch((error) => {
    result.shutdownWarning = String(error.message || error);
    child.kill('SIGKILL');
  });
  await deadline(closed, 15_000, 'wait for the owned Electron process to exit');
}

async function run() {
  const png = fixturePng();
  const base64 = png.toString('base64');
  result.fixture = {
    width: 256,
    height: 256,
    pngBytes: png.length,
    imageCount: 64,
    watchCycles: 16,
  };

  await check('production startup, identity and visible renderer', async () => {
    await launch();
    const identity = await ownedApp.evaluate(({ app, BrowserWindow }) => ({
      name: app.getName(),
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      version: app.getVersion(),
      electron: process.versions.electron,
      windows: BrowserWindow.getAllWindows().map((win) => ({
        id: win.id,
        url: win.webContents.getURL(),
        visible: win.isVisible(),
      })),
    }));
    assert.equal(path.resolve(identity.userData), path.resolve(userData));
    assert.equal(identity.name, packageJson.build.productName);
    assert(
      identity.windows.some((win) => win.visible),
      'No visible BrowserWindow',
    );
    const ui = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 700),
      rootChildren: document.getElementById('root').children.length,
      hasImageService: !!window.imageService,
    }));
    assert(ui.text.trim().length > 0, 'Renderer has no visible text');
    await page.screenshot({
      path: path.join(reportDirectory, '01-main-ui.png'),
    });
    result.metrics.startup = await mainSnapshot();
    const dataRoot = await ipc('get-data-root');
    assert.equal(
      typeof dataRoot,
      'string',
      'Expected a string data-root IPC result',
    );
    const relativeDataRoot = path.relative(userData, dataRoot);
    assert(
      relativeDataRoot !== '..' &&
        !relativeDataRoot.startsWith('..' + path.sep) &&
        !path.isAbsolute(relativeDataRoot),
      'The app data root escaped the isolated profile; refusing fixture writes',
    );
    return { identity, ui, dataRoot };
  });

  await check(
    'real config write failure preserves effective and saved values, then retries',
    async () => {
      assert.equal(
        process.platform,
        'linux',
        'The real permission-failure fixture requires Linux file permissions',
      );
      assert(
        process.getuid() !== 0,
        'The real permission-failure fixture must run as the unprivileged app owner',
      );
      const before = await ipc('get-config');
      // Establish the saved baseline before making its private directory read-only.
      // Keep modelVersion unchanged so this check cannot change model assets.
      await ipc('set-config', before);
      const configDirectory = fs.realpathSync(path.join(userData, 'SDStudio'));
      assert.equal(
        path.dirname(configDirectory),
        fs.realpathSync(userData),
        'Config directory escaped the disposable profile',
      );
      const configPath = path.join(configDirectory, 'config.json');
      const savedBefore = fs.readFileSync(configPath, 'utf8');
      assert.deepEqual(JSON.parse(savedBefore), before);
      const configured = {
        ...before,
        uiFont: before.uiFont === 'pretendard' ? 'system' : 'pretendard',
      };
      const originalMode = fs.statSync(configDirectory).mode & 0o7777;
      let rejectedError;
      try {
        fs.chmodSync(configDirectory, originalMode & ~0o222);
        try {
          await ipc('set-config', configured);
        } catch (error) {
          rejectedError = String(error.message || error);
        }
        const afterFailure = await ipc('get-config');
        const savedAfterFailure = fs.readFileSync(configPath, 'utf8');
        result.configSaveFailure = {
          rejectedError,
          savedBytesUnchanged: savedAfterFailure === savedBefore,
          beforeUiFont: before.uiFont ?? null,
          afterFailedUiFont: afterFailure.uiFont ?? null,
        };
        assert.match(
          rejectedError || '',
          /\b(?:EACCES|EPERM)\b/,
          'The actual read-only config directory must reject the save',
        );
        assert.equal(
          savedAfterFailure,
          savedBefore,
          'A failed config save changed the last saved file',
        );
        assert.deepEqual(
          afterFailure,
          before,
          'A failed config save changed the effective in-memory configuration',
        );
      } finally {
        // Restore even on RED so shutdown and fixture removal remain possible.
        fs.chmodSync(configDirectory, originalMode);
      }
      await ipc('set-config', configured);
      assert.deepEqual(await ipc('get-config'), configured);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(configPath, 'utf8')),
        configured,
      );
      await shutdown();
      await launch();
      const restored = await ipc('get-config');
      assert.equal(restored.uiFont, configured.uiFont);
      assert.equal(restored.modelVersion, before.modelVersion);
      assert.equal(restored.effort, before.effort);
      return {
        ...result.configSaveFailure,
        retrySavedUiFont: configured.uiFont,
        reopenedUiFont: restored.uiFont,
      };
    },
  );

  await check('titlebar balance quota and narrow-window controls', () =>
    verifyTitlebar({ application: ownedApp, page, reportDirectory, result }),
  );

  await check('real PNG IPC and concurrent image/thumbnail work', async () => {
    const files = Array.from(
      { length: 64 },
      (_, index) => `smoke-fixture/images/image-${index}.png`,
    );
    await page.evaluate(
      async ({ files, base64 }) => {
        for (const file of files)
          await window.electron.ipcRenderer.invoke(
            'write-data-file',
            file,
            base64,
          );
      },
      { files, base64 },
    );
    const readBack = await ipc('read-data-file', files[0]);
    assert.equal(readBack.slice(readBack.indexOf(',') + 1), base64);
    const burst = await page.evaluate(async (files) => {
      const service = window.imageService;
      const started = performance.now();
      const originals = await Promise.all(
        files.map((file) => service.fetchImage(file)),
      );
      const originalsMs = performance.now() - started;
      const thumbStarted = performance.now();
      const thumbnails = await Promise.all(
        files.map((file) => service.fetchImageSmall(file, 200)),
      );
      const thumbnailMs = performance.now() - thumbStarted;
      const preview = new Image();
      preview.src = thumbnails[0];
      await preview.decode();
      return {
        originals: originals.filter(Boolean).length,
        thumbnails: thumbnails.filter(Boolean).length,
        originalsMs,
        thumbnailMs,
        thumbnailWidth: preview.naturalWidth,
        thumbnailHeight: preview.naturalHeight,
        cache: {
          entries: service.cache.cache.size,
          limit: service.cache.limit,
          payloadBytes: service.cache.totalBytes,
          byteLimit: service.cache.byteLimit,
        },
        retainedMutexes: Object.keys(service.mutexes).length,
      };
    }, files);
    assert.equal(burst.originals, files.length);
    assert.equal(burst.thumbnails, files.length);
    assert(
      burst.thumbnailWidth > 0 && burst.thumbnailWidth < 256,
      'Thumbnail processing fell back to the unchanged original',
    );
    assert.equal(burst.thumbnailHeight, burst.thumbnailWidth);
    assert(burst.cache.entries <= burst.cache.limit);
    assert(burst.cache.payloadBytes <= burst.cache.byteLimit);
    assert.equal(burst.retainedMutexes, 0);
    result.metrics.afterImageBurst = await mainSnapshot();
    await page.screenshot({
      path: path.join(reportDirectory, '02-after-images.png'),
    });
    return burst;
  });

  await check(
    'real PNG clipboard IPC on the isolated Xvfb display',
    async () => {
      // Clipboard is desktop-wide, so this fixture is restricted to xvfb-run's
      // private display and never reads or changes the user's desktop clipboard.
      const authorityDirectory = path.basename(
        path.dirname(process.env.XAUTHORITY || ''),
      );
      assert(
        process.platform === 'linux' &&
          process.env.DISPLAY &&
          authorityDirectory.startsWith('xvfb-run.'),
        'Clipboard smoke requires a private xvfb-run display',
      );
      const file = 'smoke-fixture/clipboard/image.png';
      await ipc('write-data-file', file, base64);
      await ipc('copy-image-to-clipboard', file);
      const clipboardImage = await ownedApp.evaluate(
        async ({ clipboard, nativeImage }) => {
          const items = await clipboard.read();
          const pngItem = items.find((item) =>
            item.types.includes('image/png'),
          );
          if (!pngItem)
            throw new Error('Clipboard IPC did not produce image/png');
          const blob = await pngItem.getType('image/png');
          const bytes = Buffer.from(await blob.arrayBuffer());
          const image = nativeImage.createFromBuffer(bytes);
          if (image.isEmpty())
            throw new Error('Clipboard PNG could not be decoded');
          return {
            mimeType: 'image/png',
            pngBytes: bytes.length,
            ...image.getSize(),
          };
        },
      );
      assert.equal(clipboardImage.width, result.fixture.width);
      assert.equal(clipboardImage.height, result.fixture.height);
      assert(clipboardImage.pngBytes > 0);
      return { ...clipboardImage, isolatedDisplay: true };
    },
  );

  await check(
    'native directory watcher ownership returns to baseline',
    async () => {
      const before = await mainSnapshot();
      let peak = before.fsWatchers;
      for (let index = 0; index < 16; index += 1) {
        const file = `smoke-fixture/watch-${index}/image.png`;
        await ipc('write-data-file', file, base64);
        await ipc('watch-image', file);
        peak = Math.max(peak, (await mainSnapshot()).fsWatchers);
        await ipc('unwatch-image', file);
      }
      const after = await mainSnapshot();
      assert(
        after.fsWatchers <= before.fsWatchers,
        `Native FSWatcher handles grew from ${before.fsWatchers} to ${after.fsWatchers}`,
      );
      result.metrics.afterWatchCycles = after;
      return {
        cycles: 16,
        before: before.fsWatchers,
        peak,
        after: after.fsWatchers,
        nativeHandleClassObserved: peak > 0,
        additionalWatchObserved: peak > before.fsWatchers,
      };
    },
  );

  await check(
    'full renderer reload releases a still-owned image watch',
    async () => {
      const before = await mainSnapshot();
      const file = 'smoke-fixture/reload/image.png';
      await ipc('write-data-file', file, base64);
      await ipc('watch-image', file);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await ready();
      const after = await mainSnapshot();
      assert(after.fsWatchers <= before.fsWatchers);
      await ipc('get-config');
      return { before: before.fsWatchers, after: after.fsWatchers };
    },
  );

  await check(
    'Medium model selection persists through a complete application restart',
    async () => {
      const before = await ipc('get-config');
      const configured = { ...before, modelVersion, effort: 'medium' };
      await ipc('set-config', configured);
      const immediate = await ipc('get-config');
      assert.equal(immediate.modelVersion, modelVersion);
      assert.equal(immediate.effort, 'medium');
      await page.screenshot({
        path: path.join(reportDirectory, '03-medium-config.png'),
      });
      const visibleControl = await page
        .locator('select:has(option[value="medium"])')
        .count();
      await shutdown();
      await launch();
      const restored = await ipc('get-config');
      assert.equal(restored.modelVersion, modelVersion);
      assert.equal(restored.effort, 'medium');
      await page.screenshot({
        path: path.join(reportDirectory, '04-after-restart.png'),
      });
      return {
        modelVersion: restored.modelVersion,
        effort: restored.effort,
        mediumSelectElements: visibleControl,
        editorUiVerified: false,
        editorUiNote:
          'Configuration persistence is verified. A project editor is not opened automatically.',
      };
    },
  );

  await check(
    'normal window close preserves a real failed project save and retries',
    async () => {
      const projectName = `smoke-close-${Date.now()}`;
      const savedPrompt = 'saved close fixture';
      const pendingPrompt = 'pending close fixture';
      const projectPath = await page.evaluate(
        async ({ projectName, savedPrompt }) => {
          const service = window.sessionService;
          await service.add(projectName);
          const session = await service.get(projectName);
          if (!session) throw new Error('Close fixture project did not load');
          session.extraPrompt = savedPrompt;
          service.markDirty(projectName);
          await service.flushProjectNow(projectName);
          return service.getPath(projectName);
        },
        { projectName, savedPrompt },
      );
      const dataRoot = fs.realpathSync(await ipc('get-data-root'));
      const relativeDataRoot = path.relative(
        fs.realpathSync(userData),
        dataRoot,
      );
      assert(
        relativeDataRoot !== '..' &&
          !relativeDataRoot.startsWith('..' + path.sep) &&
          !path.isAbsolute(relativeDataRoot),
        'Close fixture data root escaped the disposable profile',
      );
      const savedFile = fs.realpathSync(path.resolve(dataRoot, projectPath));
      const projectDirectory = path.dirname(savedFile);
      const relativeProjectDirectory = path.relative(
        dataRoot,
        projectDirectory,
      );
      assert(
        relativeProjectDirectory &&
          relativeProjectDirectory !== '..' &&
          !relativeProjectDirectory.startsWith('..' + path.sep) &&
          !path.isAbsolute(relativeProjectDirectory),
        'Refusing to change permissions outside a disposable project directory',
      );
      const savedBefore = fs.readFileSync(savedFile, 'utf8');
      assert.equal(JSON.parse(savedBefore).extraPrompt, savedPrompt);
      const originalMode = fs.statSync(projectDirectory).mode & 0o7777;
      const windowId = await ownedApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((candidate) =>
          candidate.isVisible(),
        );
        if (!win) throw new Error('No owned window for the close fixture');
        return win.id;
      });
      const closeFailureMessage =
        '종료를 완료하지 못했습니다. 작업을 보존하려고 창을 열어두었습니다. 저장 상태를 확인한 후 다시 닫아 주세요.';
      try {
        fs.chmodSync(projectDirectory, originalMode & ~0o222);
        assert.throws(
          () => fs.accessSync(projectDirectory, fs.constants.W_OK),
          /\b(?:EACCES|EPERM)\b/,
          'The fixture directory must really deny writes to the app owner',
        );
        await page.evaluate(
          ({ projectName, pendingPrompt }) => {
            const service = window.sessionService;
            const session = service.getLoaded(projectName);
            if (!session)
              throw new Error('Close fixture was unexpectedly unloaded');
            session.extraPrompt = pendingPrompt;
            service.markDirty(projectName);
          },
          { projectName, pendingPrompt },
        );
        // Both IPC requests use the real native close event and renderer save handshake.
        await page.evaluate(async () => {
          await Promise.all([
            window.electron.ipcRenderer.invoke('window-close'),
            window.electron.ipcRenderer.invoke('window-close'),
          ]);
        });
        await page
          .getByText(closeFailureMessage, { exact: true })
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        assert.equal(ownedApp.process().exitCode, null);
        assert.equal(page.isClosed(), false);
        const stillVisible = await ownedApp.evaluate(
          ({ BrowserWindow }, id) => {
            const win = BrowserWindow.fromId(id);
            return !!win && !win.isDestroyed() && win.isVisible();
          },
          windowId,
        );
        assert.equal(stillVisible, true);
        const pending = await page.evaluate(
          (name) => ({
            extraPrompt: window.sessionService.getLoaded(name)?.extraPrompt,
            dirty: window.sessionService.dirtyNames().includes(name),
          }),
          projectName,
        );
        assert.equal(pending.extraPrompt, pendingPrompt);
        assert.equal(pending.dirty, true);
        assert.equal(
          fs.readFileSync(savedFile, 'utf8'),
          savedBefore,
          'The failed close changed the last saved project bytes',
        );
        result.closeSaveFailure = {
          projectName,
          realWritePermissionFailure: true,
          closeRequests: 2,
          windowKeptOpen: true,
          dirtyRetained: true,
          savedBytesUnchanged: true,
        };
        await page.screenshot({
          path: path.join(reportDirectory, '05-close-save-failure.png'),
        });
      } finally {
        fs.chmodSync(projectDirectory, originalMode);
      }

      const closingApp = ownedApp;
      const child = closingApp.process();
      const closed = once(child, 'close');
      // A successful native close may remove the renderer transport before its reply.
      // Only that transport outcome is tolerated; process exit and saved data are checked.
      await ipc('window-close').catch((error) => {
        const message = String(error.message || error);
        if (!/closed|destroyed|disposed/i.test(message)) throw error;
        result.closeSaveFailure.closeTransportMessage = message;
      });
      const [exitCode, signal] = await deadline(
        closed,
        30_000,
        'wait for a successful save acknowledgement and native window close',
      );
      assert.equal(exitCode, 0);
      assert.equal(signal, null);
      ownedApp = undefined;
      assert.equal(
        JSON.parse(fs.readFileSync(savedFile, 'utf8')).extraPrompt,
        pendingPrompt,
      );
      await launch();
      const reopenedPrompt = await page.evaluate(async (name) => {
        const session = await window.sessionService.get(name);
        if (!session) throw new Error('Saved close fixture did not reopen');
        return session.extraPrompt;
      }, projectName);
      assert.equal(reopenedPrompt, pendingPrompt);
      return {
        ...result.closeSaveFailure,
        retryClosedNormally: true,
        reopenedPrompt,
      };
    },
  );

  await check(
    'native renderer-crash choice recovers the production preload and IPC',
    async () => {
      // Playwright permanently marks a crashed Page and its auto-attached CDP
      // target can keep the replacement renderer paused. Verify recovery with
      // the unchanged production main in a process that has no debugger.
      await shutdown();
      const recoveryReport = path.join(reportDirectory, 'native-recovery');
      fs.mkdirSync(recoveryReport, { recursive: true });
      const environment = {
        ...process.env,
        NODE_ENV: 'production',
        SDSTUDIO_REPO: repository,
        SDSTUDIO_APP_PATH: applicationPath,
        SDSTUDIO_RECOVERY_REPORT_DIR: recoveryReport,
      };
      delete environment.ELECTRON_RUN_AS_NODE;
      delete environment.NODE_OPTIONS;
      const child = spawn(
        executablePath,
        [
          '--no-sandbox',
          '--disable-gpu',
          path.join(repository, 'tools/electron-recovery-smoke.cjs'),
        ],
        {
          cwd: repository,
          env: environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      for (const [stream, filename] of [
        [child.stdout, 'stdout.log'],
        [child.stderr, 'stderr.log'],
      ]) {
        stream.on('data', (data) =>
          fs.appendFileSync(path.join(recoveryReport, filename), data),
        );
      }
      let completion;
      try {
        completion = await deadline(
          once(child, 'close'),
          180_000,
          'verify native renderer recovery without a debugger',
        );
      } finally {
        // This child was created solely for this test; no user process is used.
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        const resultPath = path.join(recoveryReport, 'result.json');
        result.recoveryResultPath = resultPath;
        if (fs.existsSync(resultPath))
          result.nativeRecovery = JSON.parse(
            fs.readFileSync(resultPath, 'utf8'),
          );
        saveResult();
      }
      assert.equal(
        completion[0],
        0,
        `Native recovery process failed (${completion[1] || 'exit'}); see ${recoveryReport}`,
      );
      assert.equal(
        result.nativeRecovery?.status,
        'passed',
        'The independent recovery fixture did not pass',
      );
      assert.equal(result.nativeRecovery.blockedNovelAiRequests.length, 0);
      assert.equal(result.nativeRecovery.preloadErrors.length, 0);
      result.metrics.afterRecovery = result.nativeRecovery.metrics.after;
      return {
        verification:
          'separate native Electron process without Playwright or CDP',
        resultPath: result.recoveryResultPath,
        checks: result.nativeRecovery.checks,
      };
    },
  );

  await check(
    'no paid API activity or uncaught renderer exception',
    async () => {
      assert.equal(
        result.blockedNovelAiRequests.length,
        0,
        'An unexpected NovelAI request was attempted and blocked in the isolated fixture',
      );
      assert.equal(
        result.pageErrors.length,
        0,
        'An uncaught renderer exception was observed',
      );
      return { novelAiRequests: 0, pageErrors: 0 };
    },
  );
  result.status = 'passed';
}

run()
  .catch((error) => {
    result.status = 'failed';
    result.failure = {
      message: String(error.message || error),
      stack: error.stack,
    };
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      if (ownedApp && page && !page.isClosed()) {
        await page
          .screenshot({
            path: path.join(reportDirectory, 'final-window.png'),
            timeout: 10_000,
          })
          .catch(() => {});
      }
      await shutdown();
    } catch (error) {
      result.shutdownFailure = String(error.message || error);
      result.status = 'failed';
      process.exitCode = 1;
    } finally {
      result.finishedAt = new Date().toISOString();
      saveResult();
      if (process.env.KEEP_SMOKE_PROFILE !== '1')
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      process.stdout.write(
        `Smoke result: ${path.join(reportDirectory, 'result.json')}\n`,
      );
    }
  });
