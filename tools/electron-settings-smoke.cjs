#!/usr/bin/env node
'use strict';

/**
 * Preferences acceptance through real OS input, not DOM/CDP click injection.
 * Runs production Electron or SDSTUDIO_PACKAGED=1 + ELECTRON_EXECUTABLE.
 * Linux: xvfb-run -a npm run smoke:settings (requires xdotool).
 * Every profile and process belongs to this finite run; no paid requests.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { _electron } = require(
  process.env.PLAYWRIGHT_MODULE || 'playwright-core',
);
const { createNativeInput } = require('./electron-native-input.cjs');

const repository = path.resolve(__dirname, '..');
const out = path.resolve(
  process.env.SDSTUDIO_SETTINGS_REPORT_DIR ||
    path.join(repository, '.report/settings-smoke'),
);
const packaged = process.env.SDSTUDIO_PACKAGED === '1';
const expectedVersion = require('../package.json').version;
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'sdstudio-settings-'),
);
const userData = path.join(temporaryRoot, 'profile');
fs.mkdirSync(userData);
fs.mkdirSync(out, { recursive: true });
const result = {
  status: 'running',
  startedAt: new Date().toISOString(),
  expectedVersion,
  packaged,
  checks: [],
  errors: [],
  blockedRequests: [],
};
let application;
let page;
let input;
let phase = 'startup';

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
async function screenshot(name) {
  await page.screenshot({
    path: path.join(out, name + '.png'),
    timeout: 10000,
  });
}
async function captureFailureDesktop() {
  if (!application || process.platform !== 'win32') return;
  const capture = await application.evaluate(async ({ desktopCapturer, screen }) => {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
      },
    });
    const source = sources.find((item) => item.display_id === String(display.id));
    if (!source) throw new Error('The owned CI display is not available for capture');
    return {
      display: { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor },
      png: source.thumbnail.toPNG().toString('base64'),
    };
  });
  fs.writeFileSync(path.join(out, 'failure-desktop.png'), Buffer.from(capture.png, 'base64'));
  result.failureDesktop = { file: 'failure-desktop.png', display: capture.display };
}
async function launch() {
  const args = ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + userData];
  if (!packaged) args.push(path.join(repository, 'release/app'));
  application = await _electron.launch({
    executablePath:
      process.env.ELECTRON_EXECUTABLE ||
      require('electron'),
    args,
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60000,
  });
  application
    .process()
    .stderr?.on('data', (data) =>
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
    () =>
      window.electron?.ipcRenderer?.invoke &&
      !!document.querySelector('#root .scene-selection-surface'),
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
      // Fresh production profiles start maximized. Windows ignores ordinary
      // bounds while maximized; wait for the real state change before sizing.
      if (win.isMaximized()) {
        await new Promise((resolve) => {
          win.once('unmaximize', resolve);
          win.unmaximize();
        });
      }
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
        normalWindow: {
          maximized: win.isMaximized(),
          minimized: win.isMinimized(),
          visible: win.isVisible(),
          focused: win.isFocused(),
          contentBounds: win.getContentBounds(),
        },
        area,
      };
    },
  );
  assert.equal(path.resolve(identity.userData), path.resolve(userData));
  assert.equal(identity.version, expectedVersion);
  assert.equal(identity.packaged, packaged);
  // Keep native and renderer geometry separate in the report. The failure-time
  // native hit test records actual HWND bounds before sending any mouse input.
  const rendererGeometry = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scale: devicePixelRatio,
    focused: document.hasFocus(),
  }));
  input = await createNativeInput(application, page);
  return {
    ...identity,
    rendererGeometry,
    nativeInput: input.kind,
    nativeProcess: input.processIdentity,
  };
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
      // On Windows the owned child is Playwright's cmd.exe launcher; include
      // only its process tree so a failed main exit cannot leave Electron alive.
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 5000,
          stdio: 'ignore',
        });
      } else child.kill('SIGKILL');
    }
    await deadline(closed, 5000, 'Owned Electron cleanup did not finish');
    throw error;
  }
}
function panel() {
  return page.getByRole('dialog', { name: '환경설정', exact: true });
}
async function open() {
  await input.click(
    page
      .getByRole('button', { name: '환경설정', exact: true })
      .filter({ visible: true }),
  );
  await panel().waitFor({ state: 'visible' });
  await panel()
    .getByPlaceholder('API 토큰을 붙여넣으세요', { exact: true })
    .waitFor({ state: 'visible' });
}
async function waitClosed() {
  await page
    .getByRole('heading', { name: '환경설정', exact: true })
    .waitFor({ state: 'hidden' });
}
async function selectTab(name) {
  await input.click(panel().getByRole('button', { name, exact: true }));
  await page.waitForFunction(
    (label) =>
      [
        ...document.querySelectorAll(
          '[role="dialog"][aria-label="환경설정"] button',
        ),
      ].some(
        (button) =>
          button.textContent.trim() === label &&
          button.className.includes('border-sky-500'),
      ),
    name,
  );
}
async function config() {
  return page.evaluate(() => window.electron.ipcRenderer.invoke('get-config'));
}
async function checked(expected) {
  await page.waitForFunction(
    (value) => document.querySelector('#cfgClassicScene')?.checked === value,
    expected,
  );
}

async function main() {
  result.identity = await check(
    'isolated production startup and exact version',
    launch,
  );
  const { area } = result.identity;
  assert(
    area.width >= 480 && area.height >= 500,
    'Native screen is too small for acceptance',
  );
  const widths = [
    ...new Set([Math.min(1280, area.width), Math.min(768, area.width), 480]),
  ];
  let savedValue = false;
  for (const width of widths) {
    await check('native preferences journey at ' + width + 'px', async () => {
      await application.evaluate(
        ({ BrowserWindow }, dimensions) => {
          const win = BrowserWindow.getAllWindows().find((w) =>
            w.webContents.getURL().startsWith('file:'),
          );
          win.setContentBounds(dimensions);
        },
        { x: area.x, y: area.y, width, height: Math.min(900, area.height) },
      );
      await page.waitForFunction((w) => innerWidth === w, width);
      await open();
      const geometry = await panel().evaluate((element) => {
        const overlay = element.parentElement;
        const rect = overlay.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          viewport: { width: innerWidth, height: innerHeight },
          appRegion:
            getComputedStyle(overlay).getPropertyValue('-webkit-app-region'),
        };
      });
      assert.deepEqual(
        {
          x: geometry.x,
          y: geometry.y,
          width: geometry.width,
          height: geometry.height,
        },
        {
          x: 0,
          y: 0,
          width: geometry.viewport.width,
          height: geometry.viewport.height,
        },
      );
      assert.equal(geometry.appRegion, 'no-drag');

      if (width === widths[0]) {
        // Deliberately restore the actual old defect only in this disposable
        // renderer. A driver bypassing native non-client hit tests would fail.
        await panel().evaluate(async (element) => {
          element.parentElement.classList.remove('titlebar-no-drag');
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        try {
          assert.equal(
            await panel().evaluate((element) =>
              getComputedStyle(element).getPropertyValue('-webkit-app-region'),
            ),
            'drag',
          );
          await input.click(
            panel().getByRole('button', { name: '커스텀', exact: true }),
          );
          await page.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
              ),
          );
          assert(
            (
              await panel()
                .getByRole('button', { name: '로그인', exact: true })
                .getAttribute('class')
            ).includes('border-sky-500'),
            'Native input did not detect the deliberately restored drag-region defect',
          );
        } finally {
          await panel().evaluate(async (element) => {
            element.parentElement.classList.add('titlebar-no-drag');
            await new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
          });
        }
        result.nativeCounterfactual =
          'Removing the no-drag boundary blocked the real OS click';
      }

      const tabs = await panel().locator('button.border-b-2').allTextContents();
      assert(tabs.length >= 8, 'Expected the real desktop preferences tab set');
      for (const label of tabs) await selectTab(label.trim());
      await selectTab('로그인');
      const token = panel().getByPlaceholder('API 토큰을 붙여넣으세요', {
        exact: true,
      });
      await input.click(token);
      assert.equal(
        await token.evaluate((element) => document.activeElement === element),
        true,
      );
      await input.type('sdstudio-native-input-probe');
      assert.equal(await token.inputValue(), 'sdstudio-native-input-probe');
      await input.key('Ctrl+A');
      await input.key('Backspace');
      assert.equal(await token.inputValue(), '');

      const before = await config();
      await selectTab('커스텀');
      savedValue = !(before.classicSceneCard ?? false);
      await input.click(panel().locator('#cfgClassicScene'));
      await checked(savedValue);
      await screenshot('settings-' + width);
      await input.click(
        panel().getByRole('button', { name: '저장', exact: true }),
      );
      await waitClosed();
      const after = await config();
      assert.equal(after.classicSceneCard, savedValue);
      assert.equal(after.modelVersion, before.modelVersion);

      await open();
      await selectTab('커스텀');
      await checked(savedValue);
      await input.click(
        panel().getByRole('button', { name: '닫기', exact: true }),
      );
      await waitClosed();

      await open();
      await input.key('Escape');
      await waitClosed();

      await open();
      await input.clickAt(8, Math.floor(geometry.viewport.height / 2));
      await waitClosed();
      return {
        geometry,
        tabs: tabs.map((s) => s.trim()),
        nativeInputAndClear: true,
        savedClassicSceneCard: savedValue,
        reopen: true,
        closeButton: true,
        escape: true,
        backdrop: true,
      };
    });
  }

  await check('saved preferences survive a full process restart', async () => {
    await shutdown();
    const restarted = await launch();
    result.restartedIdentity = restarted;
    write();
    await open();
    await selectTab('커스텀');
    await checked(savedValue);
    assert.equal((await config()).classicSceneCard, savedValue);
    await input.click(
      panel().getByRole('button', { name: '닫기', exact: true }),
    );
    await waitClosed();
    return { version: restarted.version, classicSceneCard: savedValue };
  });
  assert.equal(
    result.errors.length,
    0,
    'An uncaught renderer error was observed',
  );
  assert.equal(
    result.blockedRequests.filter((request) => request.method !== 'GET').length,
    0,
  );
  result.status = 'passed';
}

main()
  .catch(async (error) => {
    result.status = 'failed';
    result.error = { message: error.message, stack: error.stack, phase };
    await captureFailureDesktop().catch((captureError) => {
      result.desktopCaptureError = captureError.message;
    });
    if (page && !page.isClosed()) {
      await screenshot('failure').catch(() => {});
      const visible = await page
        .evaluate(() => document.body.innerText)
        .catch(() => '');
      fs.writeFileSync(path.join(out, 'failure-visible.txt'), visible);
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
      process.stdout.write(
        'Preferences result: ' + path.join(out, 'result.json') + '\n',
      );
    }
  });
