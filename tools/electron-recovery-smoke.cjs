#!/usr/bin/env node
'use strict';

/**
 * Runs the built application's real main/preload/renderer without Playwright,
 * CDP, or a debugger. Only the native recovery dialog choice is supplied by the
 * fixture. A fresh profile is created before the product main is imported.
 *
 * NODE_ENV=production SDSTUDIO_REPO=/absolute/repository \
 *   xvfb-run -a /verified/electron --no-sandbox --disable-gpu \
 *   tools/electron-recovery-smoke.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const inspector = require('node:inspector');
const { once } = require('node:events');
assert(
  process.versions.electron && process.type === 'browser',
  'Run this fixture directly with Electron, without Playwright or ELECTRON_RUN_AS_NODE',
);
const { app, BrowserWindow, dialog, session } = require('electron');
const repository = path.resolve(
  process.env.SDSTUDIO_REPO || path.join(__dirname, '..'),
);
const applicationPath = path.resolve(
  process.env.SDSTUDIO_APP_PATH || path.join(repository, 'release/app'),
);
const applicationPackage = JSON.parse(
  fs.readFileSync(path.join(applicationPath, 'package.json'), 'utf8'),
);
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(repository, 'package.json'), 'utf8'),
);
const mainPath = path.resolve(applicationPath, applicationPackage.main);
const reportDirectory = path.resolve(
  process.env.SDSTUDIO_RECOVERY_REPORT_DIR ||
    path.join(
      repository,
      '.report',
      `electron-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    ),
);
fs.mkdirSync(reportDirectory, { recursive: true });
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'cupcake-sdstudio-recovery-'),
);
const userData = path.join(temporaryRoot, 'profile');
fs.mkdirSync(userData);
process.env.NODE_ENV = 'production';
delete process.env.DEBUG_PROD;
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.commandLine.appendSwitch('user-data-dir', userData);
app.setAppPath(applicationPath);

const result = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  mode: 'native-electron-without-debugger',
  applicationPath,
  mainPath,
  isolatedUserData: userData,
  reportDirectory,
  versions: process.versions,
  checks: [],
  events: [],
  blockedNovelAiRequests: [],
  preloadErrors: [],
  consoleErrors: [],
  metrics: {},
};
let window;
let initialLoad;
let phase = 'load-production-main';
let finished = false;
let awaitingChoice = false;
let loadsBeforeChoice = 0;
let chooseRecovery;
let announcePrompt;
const promptReady = new Promise((resolve) => {
  announcePrompt = resolve;
});
let announceWindow;
const firstWindow = new Promise((resolve) => {
  announceWindow = resolve;
});

function saveResult() {
  fs.writeFileSync(
    path.join(reportDirectory, 'result.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
}
function record(event, detail = {}) {
  result.events.push({ event, phase, time: Date.now(), ...detail });
  saveResult();
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
    throw error;
  }
}
function finish(error) {
  if (finished) return;
  finished = true;
  result.status = error ? 'failed' : 'passed';
  if (error) {
    result.failure = {
      message: String(error.message || error),
      stack: error.stack,
    };
    process.stderr.write(`${error.stack || error}\n`);
  }
  result.finishedAt = new Date().toISOString();
  result.finalWindow =
    window && !window.isDestroyed()
      ? {
          id: window.id,
          url: window.webContents.getURL(),
          loading: window.webContents.isLoading(),
          crashed: window.webContents.isCrashed(),
          rendererPid: window.webContents.getOSProcessId(),
        }
      : { destroyed: true };
  saveResult();
  process.stdout.write(
    `Recovery result: ${path.join(reportDirectory, 'result.json')}\n`,
  );
  // The fixture owns this process and profile. Avoid the product's user-save
  // close handshake when exiting a test, including after a failed renderer.
  app.exit(error ? 1 : 0);
}
process.on('uncaughtException', finish);
process.on('unhandledRejection', (reason) =>
  finish(reason instanceof Error ? reason : new Error(String(reason))),
);
process.once('exit', () => {
  if (process.env.KEEP_SMOKE_PROFILE !== '1')
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function blockPaidRequests() {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['https://*.novelai.net/*', 'https://novelai.net/*'] },
    (details, callback) => {
      const url = new URL(details.url);
      result.blockedNovelAiRequests.push({
        phase,
        method: details.method,
        url: url.origin + url.pathname,
      });
      callback({ cancel: true });
    },
  );
}
if (app.isReady()) blockPaidRequests();
else app.once('ready', blockPaidRequests);

const originalDialog = dialog.showMessageBox.bind(dialog);
dialog.showMessageBox = (...args) => {
  const options = args.length > 1 ? args[1] : args[0];
  if (options.title !== '화면 복구') return originalDialog(...args);
  result.recoveryPrompt = {
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: options.buttons,
  };
  record('recovery-prompt');
  const answer = new Promise((resolve) => {
    chooseRecovery = () => {
      record('explicit-choice', { response: 0 });
      awaitingChoice = false;
      resolve({ response: 0, checkboxChecked: false });
    };
  });
  announcePrompt();
  return answer;
};
app.on('browser-window-created', (_event, createdWindow) => {
  if (window) return;
  window = createdWindow;
  const contents = window.webContents;
  initialLoad = once(contents, 'did-finish-load');
  contents.on('did-start-loading', () => {
    if (awaitingChoice) loadsBeforeChoice += 1;
    record('did-start-loading', { pid: contents.getOSProcessId() });
  });
  contents.on('did-start-navigation', (_event, url, inPlace, mainFrame) =>
    record('did-start-navigation', { url, inPlace, mainFrame }),
  );
  contents.on('dom-ready', () => record('dom-ready'));
  contents.on('did-finish-load', () =>
    record('did-finish-load', { pid: contents.getOSProcessId() }),
  );
  contents.on('did-fail-load', (_event, code, description, url, mainFrame) =>
    record('did-fail-load', { code, description, url, mainFrame }),
  );
  contents.on('render-process-gone', (_event, detail) =>
    record('render-process-gone', detail),
  );
  contents.on('preload-error', (_event, preloadPath, error) => {
    result.preloadErrors.push({
      preloadPath,
      message: String(error.message || error),
    });
  });
  contents.on('console-message', (detail) => {
    if (detail.level === 'error')
      result.consoleErrors.push({
        phase,
        message: detail.message,
        sourceId: detail.sourceId,
      });
  });
  contents.on('destroyed', () => record('webContents-destroyed'));
  window.on('closed', () => record('window-closed'));
  announceWindow(window);
});

async function ready() {
  return deadline(
    window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const inspect = () => {
        const surface = document.querySelector('#root .scene-selection-surface');
        return !!(window.electron?.ipcRenderer?.invoke && window.imageService &&
          surface && surface.getBoundingClientRect().width > 0 &&
          surface.getBoundingClientRect().height > 0);
      };
      const detail = () => ({ ready: true, title: document.title,
        text: document.body.innerText.slice(0, 700), hasImageService: !!window.imageService });
      if (inspect()) { resolve(detail()); return; }
      const observer = new MutationObserver(() => {
        if (!inspect()) return;
        observer.disconnect(); resolve(detail());
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    })
  `),
    60_000,
    'wait for the real application surface and production preload',
  );
}
function ipc(channel, ...args) {
  const input = JSON.stringify({ channel, args });
  return window.webContents.executeJavaScript(`
    (() => { const { channel, args } = ${input};
      return window.electron.ipcRenderer.invoke(channel, ...args); })()
  `);
}
async function snapshot() {
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
}
async function screenshot(filename) {
  const image = await window.webContents.capturePage();
  assert(!image.isEmpty(), 'The recovered window has no captured pixels');
  fs.writeFileSync(path.join(reportDirectory, filename), image.toPNG());
}
function fixturePng() {
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const tag = Buffer.from(type);
    const output = Buffer.alloc(12 + data.length);
    output.writeUInt32BE(data.length);
    tag.copy(output, 4);
    data.copy(output, 8);
    output.writeUInt32BE(crc32(Buffer.concat([tag, data])), output.length - 4);
    return output;
  };
  const width = 256;
  const height = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = y * (1 + width * 4) + 1 + x * 4;
      pixels[offset] = x;
      pixels[offset + 1] = y;
      pixels[offset + 2] = x ^ y;
      pixels[offset + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function run() {
  assert.equal(
    inspector.url(),
    undefined,
    'No Node inspector may be attached to this recovery fixture',
  );
  for (const option of [
    'remote-debugging-port',
    'remote-debugging-pipe',
    'inspect',
    'inspect-brk',
  ])
    assert(
      !app.commandLine.hasSwitch(option),
      `Unexpected debugger launch option: ${option}`,
    );
  assert.equal(path.resolve(app.getPath('userData')), userData);
  assert(fs.existsSync(mainPath), `Production main is missing: ${mainPath}`);
  // This is the unchanged built product entry, including its own crash handler.
  require(mainPath);
  await deadline(firstWindow, 60_000, 'create the production BrowserWindow');
  await deadline(initialLoad, 60_000, 'load the production renderer');
  await check('actual production UI and IPC without any debugger', async () => {
    const ui = await ready();
    const dataRoot = path.resolve(await ipc('get-data-root'));
    assert(
      dataRoot.startsWith(userData + path.sep),
      'Fixture data root escaped the isolated profile',
    );
    assert.equal(app.getName(), rootPackage.build.productName);
    assert.equal(path.resolve(app.getPath('userData')), userData);
    assert.equal(path.resolve(app.getAppPath()), applicationPath);
    assert.equal(window.webContents.debugger.isAttached(), false);
    assert(window.isVisible(), 'Production window is not visible');
    result.debugger = {
      nodeInspector: inspector.url() || null,
      electronDebugger: false,
      remoteDebugging: false,
    };
    await screenshot('01-production-ui.png');
    return {
      ui,
      dataRoot,
      name: app.getName(),
      applicationVersion: applicationPackage.version,
    };
  });

  const source = fs.readFileSync(
    path.join(repository, 'src/renderer/backends/imageGen.ts'),
    'utf8',
  );
  const modelEnum = /export enum ModelVersion\s*\{([\s\S]*?)\}/.exec(source);
  const match = modelEnum && /\bV5\s*=\s*['"]([^'"]+)['"]/.exec(modelEnum[1]);
  assert(match, 'Cannot resolve the repository V5 model enum');
  const modelVersion = match[1];
  const config = await ipc('get-config');
  await ipc('set-config', { ...config, modelVersion, effort: 'medium' });
  const base64 = fixturePng().toString('base64');
  const file = 'smoke-fixture/native-recovery/image.png';
  const before = await snapshot();
  result.metrics.before = before;
  await check('real PNG IPC and an owned native directory watch', async () => {
    await ipc('write-data-file', file, base64);
    const data = await ipc('read-data-file', file);
    assert.equal(data.split(',')[1], base64);
    await ipc('watch-image', file);
    const watched = await snapshot();
    result.metrics.watched = watched;
    assert(
      watched.fsWatchers > before.fsWatchers,
      'No native watch was created for the fixture',
    );
    return {
      before: before.fsWatchers,
      watched: watched.fsWatchers,
      pngBytes: Buffer.from(base64, 'base64').length,
    };
  });

  await check(
    'explicit native recovery restores real UI and IPC after renderer crash',
    async () => {
      const originalPid = window.webContents.getOSProcessId();
      const reloaded = once(window.webContents, 'did-finish-load');
      awaitingChoice = true;
      window.webContents.forcefullyCrashRenderer();
      await deadline(
        promptReady,
        30_000,
        'wait for the native recovery dialog',
      );
      assert.equal(
        loadsBeforeChoice,
        0,
        'Product reloaded before the explicit recovery choice',
      );
      assert.deepEqual(result.recoveryPrompt.buttons, [
        '화면 다시 열기',
        '창 닫기',
      ]);
      assert.equal(typeof chooseRecovery, 'function');
      chooseRecovery();
      await deadline(
        reloaded,
        60_000,
        'load the production renderer after the explicit choice',
      );
      const ui = await ready();
      const restored = await ipc('get-config');
      assert.equal(restored.effort, 'medium');
      assert.equal(restored.modelVersion, modelVersion);
      const data = await ipc('read-data-file', file);
      assert.equal(data.split(',')[1], base64);
      const after = await snapshot();
      result.metrics.after = after;
      assert(
        after.fsWatchers <= before.fsWatchers,
        'The crashed renderer retained native image watches',
      );
      assert.equal(window.webContents.isCrashed(), false);
      assert.equal(window.webContents.isLoading(), false);
      const recoveredPid = window.webContents.getOSProcessId();
      assert(
        recoveredPid > 0 && recoveredPid !== originalPid,
        'A replacement renderer was not created',
      );
      await screenshot('02-after-native-recovery.png');
      assert.equal(result.preloadErrors.length, 0);
      assert.equal(
        result.blockedNovelAiRequests.length,
        0,
        'A NovelAI request was attempted in the isolated fixture',
      );
      return {
        ui,
        originalPid,
        recoveredPid,
        effort: restored.effort,
        modelVersion: restored.modelVersion,
        watcherBefore: before.fsWatchers,
        watcherAfter: after.fsWatchers,
        loadsBeforeChoice,
        pngRoundTrip: true,
        novelAiRequests: 0,
      };
    },
  );
}

saveResult();
run().then(
  () => finish(),
  (reason) =>
    finish(reason instanceof Error ? reason : new Error(String(reason))),
);
