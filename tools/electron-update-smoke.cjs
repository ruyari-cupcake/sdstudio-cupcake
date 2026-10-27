#!/usr/bin/env node
'use strict';

/**
 * Production updater preferences through native OS input and the real IPC
 * state endpoint. Run once for each built channel. This fixture owns its fresh
 * profile, never connects an account, and never downloads or installs an update.
 * Linux: xvfb-run -a node tools/electron-update-smoke.cjs
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
const { readReleaseIdentity } = require('./release-identity.cjs');

const repository = path.resolve(__dirname, '..');
const expected = readReleaseIdentity(repository);
const packaged = process.env.SDSTUDIO_PACKAGED === '1';
const out = path.resolve(
  process.env.SDSTUDIO_UPDATE_REPORT_DIR ||
    path.join(repository, '.report/update-smoke'),
);
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'sdstudio-update-'),
);
const userData = path.join(temporaryRoot, 'profile');
fs.mkdirSync(userData);
fs.mkdirSync(out, { recursive: true });
const result = {
  status: 'running',
  startedAt: new Date().toISOString(),
  expectedVersion: expected.version,
  expectedChannel: expected.channel,
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
  const started = Date.now();
  try {
    const detail = await action();
    result.checks.push({
      name,
      status: 'passed',
      durationMs: Date.now() - started,
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

async function launch() {
  const args = ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + userData];
  if (!packaged) args.push(path.join(repository, 'release/app'));
  application = await _electron.launch({
    executablePath:
      process.env.ELECTRON_EXECUTABLE ||
      path.join(repository, 'node_modules/electron/dist/electron'),
    args,
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60000,
  });
  application.process().stderr?.on('data', (data) =>
    fs.appendFileSync(path.join(out, 'stderr.log'), data),
  );
  await application.context().route(/https:\/\/[^/]*novelai\.net\//i, (route) => {
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
      const win = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('file:'),
      );
      const area = screen.getPrimaryDisplay().workArea;
      win.setMinimumSize(320, 400);
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
        packaged: app.isPackaged,
        userData: app.getPath('userData'),
        platform: process.platform,
        electron: process.versions.electron,
        area,
      };
    },
  );
  assert.equal(path.resolve(identity.userData), path.resolve(userData));
  assert.equal(identity.version, expected.version);
  assert.equal(identity.packaged, packaged);
  assert(identity.area.width >= 480 && identity.area.height >= 500);
  input = await createNativeInput(application, page);
  return {
    ...identity,
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

function section() {
  return panel().getByRole('region', { name: '앱 업데이트', exact: true });
}

async function nativeState() {
  const state = await page.evaluate(() =>
    window.electron.ipcRenderer.invoke('app-update', 'state'),
  );
  assert.deepEqual(Object.keys(state).sort(), [
    'channel', 'connected', 'snoozedUntil', 'supported', 'version',
  ]);
  assert.equal(state.channel, expected.channel);
  assert.equal(state.version, expected.version);
  assert.equal(typeof state.supported, 'boolean');
  assert.equal(typeof state.connected, 'boolean');
  assert.equal(state.snoozedUntil, 0, 'A fresh profile inherited update preferences');
  if (packaged && result.identity.platform === 'win32') {
    assert.equal(state.supported, true, 'The packaged Windows updater is unavailable');
  }
  if (state.channel === 'private') {
    assert.equal(state.connected, false, 'A fresh profile inherited update credentials');
  }
  return state;
}

async function dismissAvailableUpdate() {
  // A real newer release may be available by the time this check runs.
  const notice = page.getByRole('dialog', { name: '앱 업데이트', exact: true });
  if (await notice.isVisible()) {
    await input.click(notice.getByRole('button', { name: '나중에', exact: true }));
    await notice.waitFor({ state: 'hidden' });
  }
}

async function openUpdateSettings() {
  await dismissAvailableUpdate();
  await input.click(
    page.getByRole('button', { name: '환경설정', exact: true }).filter({ visible: true }),
  );
  await panel().waitFor({ state: 'visible' });
  await input.click(panel().getByRole('button', { name: '시스템', exact: true }));
  await section().waitFor({ state: 'visible' });
  await section().scrollIntoViewIfNeeded();
  const label = expected.channel === 'public' ? '공개판' : '비공개판';
  await section().getByText(`${label} · ${expected.version}`, { exact: true })
    .waitFor({ state: 'visible' });
}

async function verifyChannelControls(state) {
  const updater = section();
  const token = updater.getByLabel('GitHub 업데이트 토큰', { exact: true });
  const help = updater.getByRole('button', {
    name: '비공개 업데이트 연결 도움말', exact: true,
  });
  const manual = updater.getByRole('button', { name: '업데이트 확인', exact: true });
  if (!state.supported) {
    await updater.getByText('이 환경에서는 자동 업데이트를 사용할 수 없어요.', {
      exact: true,
    }).waitFor({ state: 'visible' });
    assert.equal(await token.count(), 0);
    assert.equal(await manual.count(), 0);
    return { supported: false, unavailableStateVisible: true };
  }
  if (state.channel === 'public') {
    assert.equal(await token.count(), 0);
    assert.equal(await help.count(), 0);
    await manual.waitFor({ state: 'visible' });
    assert.equal(await manual.isEnabled(), true);
    await dismissAvailableUpdate();
    return { supported: true, publicControls: true, privateCredentialsAbsent: true };
  }

  await token.waitFor({ state: 'visible' });
  assert.equal(await token.getAttribute('type'), 'password');
  assert.equal(await token.getAttribute('autocomplete'), 'off');
  assert.equal(await token.inputValue(), '');
  assert.equal(await manual.isDisabled(), true);
  const connect = updater.getByRole('button', { name: '연결', exact: true });
  assert.equal(await connect.isDisabled(), true);
  assert.equal(await help.getAttribute('aria-expanded'), 'false');
  assert.equal(await updater.getByRole('note').count(), 0);
  const dialogs = await page.getByRole('dialog').count();
  await input.click(help);
  await updater.getByRole('note').waitFor({ state: 'visible' });
  assert.equal(await help.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.getByRole('dialog').count(), dialogs);
  assert((await updater.getByRole('note').innerText()).includes('Contents'));
  await screenshot('private-inline-help');
  await input.click(help);
  await updater.getByRole('note').waitFor({ state: 'detached' });

  await input.click(token);
  await input.type('sdstudio-update-input-probe');
  assert.equal(await token.inputValue(), 'sdstudio-update-input-probe');
  assert.equal(await connect.isEnabled(), true);
  await input.key('Ctrl+A');
  await input.key('Backspace');
  assert.equal(await token.inputValue(), '');
  assert.equal(await connect.isDisabled(), true);
  return {
    supported: true,
    disconnectedPrivateControls: true,
    passwordInput: true,
    nativeInputAndClear: true,
    inlineHelpWithoutAnotherDialog: true,
  };
}

async function main() {
  result.identity = await check('isolated production startup and exact identity', launch);
  result.nativeState = await check('native updater returns the built channel and fresh state', nativeState);
  await check('native preferences input reaches the update section', async () => {
    await openUpdateSettings();
    await screenshot('update-settings');
    return { channel: expected.channel, version: expected.version };
  });
  await check('update controls match the real native channel', () =>
    verifyChannelControls(result.nativeState),
  );
  await check('opening help and typing do not connect or alter update preferences', async () => {
    assert.deepEqual(await nativeState(), result.nativeState);
    await input.click(panel().getByRole('button', { name: '닫기', exact: true }));
    await panel().waitFor({ state: 'hidden' });
    return { unchanged: true, preferencesClosed: true };
  });
  assert.equal(result.errors.length, 0, 'An uncaught renderer error was observed');
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
      await screenshot('failure').catch(() => {});
      const visible = await page.evaluate(() => document.body.innerText).catch(() => '');
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
      process.stdout.write('Updater result: ' + path.join(out, 'result.json') + '\n');
    }
  });
