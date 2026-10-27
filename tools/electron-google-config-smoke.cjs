#!/usr/bin/env node
'use strict';

/**
 * Production Google app-configuration acceptance with a disposable profile.
 * Only the OS file picker and shell.openExternal are replaced. Authentication
 * state, IPC, JSON validation, disk publication, UI, restart and loopback/PKCE
 * ownership all run through the production application.
 * No browser is opened, no account is authorized and no auth callback is sent.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const repository = path.resolve(process.env.SDSTUDIO_REPO || path.join(__dirname, '..'));
const applicationPath = path.resolve(
  process.env.SDSTUDIO_APP_PATH || path.join(repository, 'release/app'),
);
const executablePath = process.env.ELECTRON_EXECUTABLE;
assert(executablePath, 'Set ELECTRON_EXECUTABLE to the verified Electron runtime');
const packaged = process.env.SDSTUDIO_PACKAGED === '1';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDirectory = path.resolve(
  process.env.SDSTUDIO_SMOKE_REPORT_DIR ||
    path.join(repository, '.report', 'electron-google-config-' + stamp),
);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdstudio-google-config-'));
const userData = path.join(temporaryRoot, 'profile');
const fixturePath = path.join(temporaryRoot, 'desktop-client.json');
const clientPath = path.join(userData, 'google-drive-client.json');
const clientId = 'smoke.apps.googleusercontent.com';
const clientSecret = 'smoke-client-value';
fs.mkdirSync(userData);
fs.mkdirSync(reportDirectory, { recursive: true });
fs.writeFileSync(fixturePath, JSON.stringify({
  installed: {
    client_id: clientId,
    client_secret: clientSecret,
    auth_uri: 'https://unexpected.invalid/auth',
    token_uri: 'https://unexpected.invalid/token',
    redirect_uris: ['https://unexpected.invalid/callback'],
    refresh_token: 'ignored-token',
  },
}), { mode: 0o600 });

const result = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  applicationPath,
  executablePath,
  isolatedUserData: userData,
  checks: [],
  pageErrors: [],
  consoleErrors: [],
  blockedProviderRequests: [],
  verificationScope: {
    picker: 'native picker result replaced with a synthetic desktop-client JSON',
    browser: 'shell.openExternal recorded without opening a browser',
    ui: 'Playwright input; native OS input remains covered by the preferences smoke',
    liveAccountAuthorization: false,
  },
};
let application;
let page;
let phase = 'startup';

function writeResult() {
  fs.writeFileSync(path.join(reportDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
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

async function check(name, action) {
  phase = name;
  const started = Date.now();
  try {
    const detail = await action();
    result.checks.push({ name, status: 'passed', durationMs: Date.now() - started, detail });
    writeResult();
    process.stdout.write('PASS ' + name + '\n');
    return detail;
  } catch (error) {
    result.checks.push({ name, status: 'failed', durationMs: Date.now() - started, error: error.message });
    writeResult();
    throw error;
  }
}

async function ipc(channel) {
  return page.evaluate(name => window.electron.ipcRenderer.invoke(name), channel);
}

async function screenshot(name) {
  await page.screenshot({ path: path.join(reportDirectory, name + '.png'), timeout: 10000 });
}

function panel() {
  return page.getByRole('dialog', { name: '환경설정', exact: true });
}

function connectButton() {
  return panel().getByRole('button', { name: 'Google 계정 연결', exact: true });
}

function configureButton() {
  return panel().getByRole('button', { name: 'Google 앱 설정 불러오기', exact: true });
}

async function ready() {
  await page.waitForFunction(() => {
    const surface = document.querySelector('#root .scene-selection-surface');
    return !!(
      window.electron?.ipcRenderer?.invoke &&
      window.imageService &&
      surface &&
      surface.getBoundingClientRect().width > 0 &&
      surface.getBoundingClientRect().height > 0
    );
  }, undefined, { timeout: 60000 });
}

async function launch() {
  const args = ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + userData];
  if (!packaged) args.push(applicationPath);
  application = await _electron.launch({
    executablePath,
    args,
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60000,
  });
  const child = application.process();
  child.stderr?.on('data', bytes => fs.appendFileSync(path.join(reportDirectory, 'stderr.log'), bytes));
  child.stdout?.on('data', bytes => fs.appendFileSync(path.join(reportDirectory, 'stdout.log'), bytes));
  await application.context().route(/https:\/\/[^/]*novelai\.net\//i, async route => {
    const request = route.request();
    const url = new URL(request.url());
    result.blockedProviderRequests.push({ phase, method: request.method(), url: url.origin + url.pathname });
    await route.abort('blockedbyclient');
  });
  // Install these substitutions before interacting with any Google controls.
  const identity = await application.evaluate(({ app, dialog, shell }, selectedFile) => {
    globalThis.__sdstudioGoogleConfigSmoke = {
      selectedFile,
      pickerMode: 'cancel',
      pickerCalls: 0,
      openedUrls: [],
      onOpen: null,
      originalPicker: dialog.showOpenDialog,
      originalOpenExternal: shell.openExternal,
    };
    dialog.showOpenDialog = async (...args) => {
      const state = globalThis.__sdstudioGoogleConfigSmoke;
      state.pickerCalls += 1;
      const options = args[args.length - 1];
      state.lastPicker = { title: options.title, properties: options.properties, filters: options.filters };
      return state.pickerMode === 'select'
        ? { canceled: false, filePaths: [state.selectedFile] }
        : { canceled: true, filePaths: [] };
    };
    shell.openExternal = async url => {
      const state = globalThis.__sdstudioGoogleConfigSmoke;
      state.openedUrls.push(url);
      if (state.onOpen) {
        state.onOpen(url);
        state.onOpen = null;
      }
    };
    return {
      version: app.getVersion(),
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
      platform: process.platform,
      electron: process.versions.electron,
    };
  }, fixturePath);
  assert.equal(path.resolve(identity.userData), path.resolve(userData));
  assert.equal(identity.packaged, packaged);
  page = await application.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => result.pageErrors.push({ phase, message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') result.consoleErrors.push({ phase, message: message.text() });
  });
  await ready();
  return identity;
}

async function openDriveSettings() {
  const notice = page.getByRole('dialog', { name: '앱 업데이트', exact: true });
  if (await notice.isVisible()) {
    await notice.getByRole('button', { name: '나중에', exact: true }).click();
    await notice.waitFor({ state: 'hidden' });
  }
  await page.getByRole('button', { name: '환경설정', exact: true }).filter({ visible: true }).click();
  await panel().waitFor({ state: 'visible' });
  await panel().getByRole('button', { name: '드라이브', exact: true }).click();
  await configureButton().waitFor({ state: 'visible' });
  await page.waitForFunction(button => !button.disabled, await configureButton().elementHandle());
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
          windowsHide: true, timeout: 5000, stdio: 'ignore',
        });
      } else child.kill('SIGKILL');
    }
    await deadline(closed, 5000, 'Owned Electron cleanup did not finish').catch(() => {});
    throw error;
  }
}

async function run() {
  result.identity = await check('isolated production startup and Google settings UI', async () => {
    const identity = await launch();
    await openDriveSettings();
    const state = await ipc('drive-auth-status');
    assert.equal(state.connected, false);
    assert.equal(await configureButton().isEnabled(), true);
    assert.equal(await connectButton().isDisabled(), !!state.notConfigured);
    assert.equal(fs.existsSync(clientPath), false);
    assert.equal(fs.existsSync(path.join(userData, 'google-drive-auth.json')), false);
    return { ...identity, bundledClientConfigured: !state.notConfigured };
  });

  await check('cancelled native picker leaves the original status and disk unchanged', async () => {
    const before = await ipc('drive-auth-status');
    const answer = await ipc('drive-auth-configure');
    assert.deepEqual(answer, { ok: true, status: null });
    assert.deepEqual(await ipc('drive-auth-status'), before);
    assert.equal(fs.existsSync(clientPath), false);
    return { cancelled: true, clientFileCreated: false };
  });

  await check('real preferences action commits only application fields and enables connecting', async () => {
    await application.evaluate(() => { globalThis.__sdstudioGoogleConfigSmoke.pickerMode = 'select'; });
    await configureButton().click();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')]
        .find(element => element.textContent.trim() === 'Google 계정 연결');
      return button && !button.disabled;
    });
    const state = await ipc('drive-auth-status');
    assert.equal(state.notConfigured, undefined);
    assert.equal(state.connected, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(clientPath, 'utf8')), {
      installed: { client_id: clientId, client_secret: clientSecret },
    });
    const picker = await application.evaluate(() => {
      const state = globalThis.__sdstudioGoogleConfigSmoke;
      return { calls: state.pickerCalls, options: state.lastPicker };
    });
    assert.equal(picker.calls, 2);
    assert.equal(picker.options.title, 'Google 앱 설정 불러오기');
    assert.deepEqual(picker.options.properties, ['openFile']);
    assert.deepEqual(picker.options.filters[0].extensions, ['json']);
    assert(!JSON.stringify(state).includes(clientId));
    assert(!JSON.stringify(state).includes(clientSecret));
    assert.equal(fs.existsSync(path.join(userData, 'google-drive-auth.json')), false);
    await screenshot('configured');
    return { exactStoredFields: ['client_id', 'client_secret'], accountTokensStored: false, connectEnabled: true };
  });

  await check('cold restart reloads the saved app configuration through real IPC and UI', async () => {
    const before = fs.readFileSync(clientPath, 'utf8');
    await shutdown();
    const identity = await launch();
    assert.equal(identity.version, result.identity.version);
    await openDriveSettings();
    const state = await ipc('drive-auth-status');
    assert.equal(state.notConfigured, undefined);
    assert.equal(state.connected, false);
    assert.equal(await connectButton().isEnabled(), true);
    assert.equal(fs.readFileSync(clientPath, 'utf8'), before);
    await screenshot('restarted');
    return { version: identity.version, persistedBytesUnchanged: true, connectEnabled: true };
  });

  let loopbackPort;
  await check('production connect creates a Google PKCE URL and its owned loopback listener', async () => {
    await connectButton().click();
    const rawUrl = await deadline(application.evaluate(async () => {
      const state = globalThis.__sdstudioGoogleConfigSmoke;
      if (state.openedUrls.length) return state.openedUrls[0];
      return new Promise(resolve => { state.onOpen = resolve; });
    }), 15000, 'Production authorization did not attempt to open the system browser');
    const url = new URL(rawUrl);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/auth');
    assert.equal(url.searchParams.get('client_id'), clientId);
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('code_challenge') || '', /^[A-Za-z0-9_-]{43,}$/);
    assert.match(url.searchParams.get('state') || '', /^[A-Za-z0-9_-]{16,}$/);
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(url.searchParams.has('refresh_token'), false);
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    assert.equal(redirect.protocol, 'http:');
    assert.equal(redirect.hostname, '127.0.0.1');
    assert.equal(redirect.pathname, '/callback');
    loopbackPort = Number(redirect.port);
    assert(Number.isInteger(loopbackPort) && loopbackPort > 0);
    const listening = await application.evaluate((_electronModule, port) =>
      process._getActiveHandles().some(handle => {
        if (handle?.constructor?.name !== 'Server' || typeof handle.address !== 'function') return false;
        const address = handle.address();
        return address && typeof address === 'object' && address.port === port && handle.listening;
      }), loopbackPort);
    assert.equal(listening, true);
    const state = await ipc('drive-auth-status');
    assert.equal(state.connecting, true);
    assert.equal(state.connected, false);
    await screenshot('authorizing');
    return { endpoint: url.origin + url.pathname, pkce: 'S256', loopbackListenerOwned: true, browserOpened: false };
  });

  await check('explicit cancellation settles auth and closes the listener without account data', async () => {
    await panel().getByRole('button', { name: '취소', exact: true }).click();
    await connectButton().waitFor({ state: 'visible' });
    await page.waitForFunction(button => !button.disabled, await connectButton().elementHandle());
    assert.equal(await connectButton().isEnabled(), true);
    const state = await ipc('drive-auth-status');
    assert.equal(!!state.connecting, false);
    assert.equal(state.connected, false);
    const listening = await application.evaluate(async (_electronModule, port) => {
      await new Promise(resolve => setImmediate(resolve));
      return process._getActiveHandles().some(handle => {
        if (handle?.constructor?.name !== 'Server' || typeof handle.address !== 'function') return false;
        const address = handle.address();
        return address && typeof address === 'object' && address.port === port && handle.listening;
      });
    }, loopbackPort);
    assert.equal(listening, false);
    assert.equal(fs.existsSync(path.join(userData, 'google-drive-auth.json')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(clientPath, 'utf8')), {
      installed: { client_id: clientId, client_secret: clientSecret },
    });
    return { authSettled: true, loopbackClosed: true, accountTokensStored: false };
  });

  assert.equal(result.pageErrors.length, 0, 'Uncaught renderer errors occurred');
  assert.equal(result.blockedProviderRequests.filter(request => request.method !== 'GET').length, 0);
  result.status = 'passed';
}

run().catch(async error => {
  result.status = 'failed';
  result.error = { phase, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) {
    await screenshot('failure').catch(() => {});
    const visible = await page.evaluate(() => document.body.innerText).catch(() => '');
    fs.writeFileSync(path.join(reportDirectory, 'failure-visible.txt'), visible);
  }
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (page && !page.isClosed()) {
      await ipc('drive-auth-cancel').catch(() => {});
    }
    await shutdown();
  } catch (error) {
    result.status = 'failed';
    result.cleanupError = error.message;
    process.exitCode = 1;
  } finally {
    result.finishedAt = new Date().toISOString();
    writeResult();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    process.stdout.write('Google configuration result: ' + path.join(reportDirectory, 'result.json') + '\n');
  }
});
