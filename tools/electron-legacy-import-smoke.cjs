#!/usr/bin/env node
'use strict';

/**
 * Production Electron legacy import acceptance using caller-supplied fixtures.
 * No user data is embedded or committed. All writes use an owned temporary
 * profile. The imported file is supplied through the real UI with an uppercase
 * extension and an empty MIME type, as produced by some native file pickers.
 *
 * SDSTUDIO_LEGACY_PROJECT=/private/project.json
 * SDSTUDIO_LEGACY_PIECES=/private/pieces.json
 * ELECTRON_EXECUTABLE=/path/to/electron PLAYWRIGHT_MODULE=/path/to/playwright
 *   xvfb-run -a node tools/electron-legacy-import-smoke.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { _electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');

const repository = path.resolve(process.env.SDSTUDIO_REPO || path.join(__dirname, '..'));
const applicationPath = path.resolve(process.env.SDSTUDIO_APP_PATH || path.join(repository, 'release/app'));
const projectPath = process.env.SDSTUDIO_LEGACY_PROJECT || process.argv[2];
const piecePath = process.env.SDSTUDIO_LEGACY_PIECES || process.argv[3];
assert(projectPath, 'Supply the private project fixture path');
const projectBytes = fs.readFileSync(projectPath);
const source = JSON.parse(projectBytes.toString('utf8').replace(/^\uFEFF/, ''));
assert(source.scenes && source.library && source.presets, 'Expected a complete legacy project');
const pieceBytes = piecePath ? fs.readFileSync(piecePath) : undefined;
const pieceSource = pieceBytes ? JSON.parse(pieceBytes.toString('utf8').replace(/^\uFEFF/, '')) : undefined;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDirectory = path.resolve(process.env.SDSTUDIO_LEGACY_REPORT_DIR || path.join(repository, '.report', `legacy-import-${stamp}`));
fs.mkdirSync(reportDirectory, { recursive: true });
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdstudio-legacy-import-'));
const userData = path.join(temporaryRoot, 'profile');
fs.mkdirSync(userData);
const result = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: 'running',
  fixtures: {
    projectBytes: projectBytes.length,
    projectSha256: hash(projectBytes),
    scenes: Object.keys(source.scenes).length,
    promptCells: Object.values(source.scenes).reduce((n, scene) => n + scene.slots.flat().length, 0),
    presets: Object.values(source.presets).reduce((n, list) => n + list.length, 0),
    libraries: Object.keys(source.library).length,
    ...(pieceBytes ? { piecesBytes: pieceBytes.length, piecesSha256: hash(pieceBytes) } : {}),
  },
  checks: [],
  pageErrors: [],
  blockedGenerationRequests: [],
};
let application;
let page;
let dataRoot;
let phase = 'startup';
function save() {
  fs.writeFileSync(path.join(reportDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}
async function check(name, action) {
  phase = name;
  const start = Date.now();
  try {
    const detail = await action();
    result.checks.push({ name, status: 'passed', durationMs: Date.now() - start, detail });
    save();
    process.stdout.write(`PASS ${name}\n`);
    return detail;
  } catch (error) {
    result.checks.push({ name, status: 'failed', durationMs: Date.now() - start, error: error.message });
    save();
    throw error;
  }
}
function assertInside(base, target) {
  const relative = path.relative(fs.realpathSync(base), fs.realpathSync(target));
  assert(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Fixture escaped its owned temporary profile');
}
async function ipc(channel, ...args) {
  return page.evaluate(({ channel, args }) => window.electron.ipcRenderer.invoke(channel, ...args), { channel, args });
}
async function launch() {
  application = await _electron.launch({
    executablePath: process.env.ELECTRON_EXECUTABLE || require('electron'),
    args: ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + userData, applicationPath],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 60000,
  });
  const child = application.process();
  child.stdout?.on('data', (data) => fs.appendFileSync(path.join(reportDirectory, 'stdout.log'), data));
  child.stderr?.on('data', (data) => fs.appendFileSync(path.join(reportDirectory, 'stderr.log'), data));
  await application.context().route(/https:\/\/[^/]*novelai\.net\//i, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    result.blockedGenerationRequests.push({ phase, method: request.method(), path: url.origin + url.pathname });
    await route.abort('blockedbyclient');
  });
  page = await application.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => result.pageErrors.push({ phase, message: error.message }));
  await page.waitForFunction(() => window.electron?.ipcRenderer?.invoke && window.sessionService && window.imageService && document.querySelector('#root .scene-selection-surface'), undefined, { timeout: 60000 });
  const identity = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), version: app.getVersion(), appPath: app.getAppPath(), electron: process.versions.electron }));
  assert.equal(path.resolve(identity.userData), path.resolve(userData));
  assert.equal(path.resolve(identity.appPath), applicationPath);
  dataRoot = await ipc('get-data-root');
  assert.equal(typeof dataRoot, 'string');
  assertInside(userData, dataRoot);
  return identity;
}
async function shutdown() {
  if (!application) return;
  const owned = application;
  application = undefined;
  const child = owned.process();
  if (child.exitCode !== null) return;
  const closed = once(child, 'close');
  await deadline(owned.evaluate(({ app }) => app.exit(0)).catch(() => {}), 10000, 'Owned app exit did not acknowledge').catch(() => child.kill('SIGKILL'));
  await deadline(closed, 15000, 'Owned Electron process did not exit');
}
async function visibleButton(names, scope = page) {
  for (const name of names) {
    const candidate = scope.getByRole('button', { name, exact: typeof name === 'string' }).filter({ visible: true });
    if (await candidate.count()) return candidate.first();
  }
  return undefined;
}
async function closeHelp() {
  const help = page.locator('div.r-modal').filter({ has: page.getByText('단축키 도움말', { exact: true }) }).filter({ visible: true });
  if (await help.count()) await help.getByRole('button', { name: '닫기', exact: true }).click();
}
async function chooseFile(button, bytes, filename) {
  const choosing = page.waitForEvent('filechooser');
  await button.click();
  const chooser = await choosing;
  await chooser.setFiles({ name: filename, mimeType: '', buffer: bytes });
}
async function drawer() {
  const trigger = page.getByRole('button', { name: '프로젝트 목록 열기 (폴더 드로어)', exact: true }).filter({ visible: true });
  await trigger.click();
}
async function selectProject(name) {
  await closeHelp();
  await drawer();
  let target = page.getByRole('button', { name: `${name} 프로젝트 선택`, exact: true }).filter({ visible: true });
  if (!(await target.count())) {
    const section = page.locator('[data-drop-unfiled="1"]').filter({ visible: true });
    await section.locator(':scope > button').click();
    target = page.getByRole('button', { name: `${name} 프로젝트 선택`, exact: true }).filter({ visible: true });
  }
  await target.click();
  await target.waitFor({ state: 'hidden' });
  await closeHelp();
}
async function savedProject(name) {
  const relative = await page.evaluate(async (name) => {
    const service = window.sessionService;
    await service.get(name);
    await service.flushProjectNow(name);
    return service.getPath(name);
  }, name);
  const target = path.resolve(dataRoot, relative);
  assertInside(userData, target);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
async function loadedSnapshot(name) {
  return page.evaluate(async (name) => {
    const project = await window.sessionService.get(name);
    if (!project) throw new Error('Imported project did not load');
    const entries = (value) => typeof value?.entries === 'function' ? Array.from(value.entries()) : Object.entries(value);
    return {
      scenes: Object.fromEntries(entries(project.scenes).map(([key, scene]) => [key, { name: scene.name, resolution: scene.resolution, slots: scene.slots.map((row) => row.map((cell) => ({ id: cell.id, prompt: cell.prompt, enabled: cell.enabled, characterPrompts: JSON.parse(JSON.stringify(cell.characterPrompts || [])) }))) }])),
      libraries: Object.fromEntries(entries(project.library).map(([key, lib]) => [key, JSON.parse(JSON.stringify(lib))])),
      presetCount: entries(project.presets).reduce((n, [, list]) => n + list.length, 0),
      selectedWorkflow: JSON.parse(JSON.stringify(project.selectedWorkflow)),
    };
  }, name);
}
function assertSceneContent(actual, expected) {
  assert.equal(Object.keys(actual).length, Object.keys(expected).length);
  for (const [name, scene] of Object.entries(expected)) {
    assert(actual[name], 'An imported scene is missing');
    assert.equal(actual[name].name, scene.name);
    assert.equal(actual[name].resolution, scene.resolution);
    assert.equal(actual[name].slots.length, scene.slots.length);
    for (let i = 0; i < scene.slots.length; i += 1) {
      assert.equal(actual[name].slots[i].length, scene.slots[i].length);
      for (let j = 0; j < scene.slots[i].length; j += 1) {
        const expectedCell = scene.slots[i][j];
        const actualCell = actual[name].slots[i][j];
        assert.equal(actualCell.prompt, expectedCell.prompt);
        assert.equal(actualCell.id, expectedCell.id);
        assert.deepEqual(actualCell.characterPrompts || [], expectedCell.characterPrompts || []);
        assert.equal(actualCell.enabled !== false, expectedCell.enabled !== false);
      }
    }
  }
}
function findImageHashes(root) {
  const found = new Map();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && /\.png$/i.test(entry.name)) found.set(hash(fs.readFileSync(target)), path.relative(root, target));
      else if (entry.isSymbolicLink()) throw new Error('Unexpected link inside owned data fixture');
    }
  }
  visit(root);
  return found;
}
async function verifyImported(name) {
  const snap = await loadedSnapshot(name);
  assertSceneContent(snap.scenes, source.scenes);
  assert.equal(snap.presetCount, result.fixtures.presets);
  assert.deepEqual(snap.selectedWorkflow, source.selectedWorkflow);
  for (const [key, value] of Object.entries(source.library)) assert.deepEqual(snap.libraries[key], value);
  const saved = await savedProject(name);
  assertSceneContent(saved.scenes, source.scenes);
  for (const [key, value] of Object.entries(source.library)) assert.deepEqual(saved.library[key], value);
  const expectedImages = Object.values(source.presets).flat().filter((preset) => typeof preset.profile === 'string' && /^[A-Za-z0-9+/=]+$/.test(preset.profile) && preset.profile.length > 100).map((preset) => hash(Buffer.from(preset.profile, 'base64')));
  const actualImages = findImageHashes(dataRoot);
  for (const expectedHash of expectedImages) assert(actualImages.has(expectedHash), 'An embedded profile PNG did not persist byte-for-byte');
  return { scenes: Object.keys(snap.scenes).length, promptCells: result.fixtures.promptCells, presets: snap.presetCount, libraries: Object.keys(snap.libraries).length, profileImageCount: expectedImages.length, profileImageSha256: expectedImages };
}
async function openTemplateDialog() {
  await closeHelp();
  let button = await visibleButton(['씬 템플릿']);
  if (!button) {
    const menu = await visibleButton(['씬 도구', '씬 도구 더보기', '씬 더보기', /씬.*(도구|더보기)/, '더보기']);
    assert(menu, 'The scene tools menu is not discoverable');
    await menu.click();
    button = await visibleButton(['씬 템플릿']);
  }
  assert(button, 'Scene template action is not discoverable');
  await button.click();
  const dialog = page.getByRole('dialog', { name: /씬 템플릿 관리/ }).filter({ visible: true });
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}
async function run() {
  await check('isolated production Electron profile and visible application', async () => {
    const identity = await launch();
    result.identity = identity;
    return { ...identity, isolatedDataRoot: dataRoot };
  });
  await check('project UI imports uppercase JSON with empty MIME type', async () => {
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'legacy-project.JSON', { type: '' }));
      const surface = document.querySelector('#root .scene-selection-surface') || document.body;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        surface.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    }, projectBytes.toString('base64'));
    await page.waitForFunction((name) => window.sessionService.list().includes(name) || [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '새 프로젝트로 불러오기'), source.name, { timeout: 60000 });
    const newProject = page.getByRole('button', { name: '새 프로젝트로 불러오기', exact: true });
    if (await newProject.isVisible()) await newProject.click();
    await page.waitForFunction(async (name) => {
      try { return !!(await window.sessionService.get(name)); }
      catch { return false; }
    }, source.name, { timeout: 60000 });
    await closeHelp();
    const detail = await verifyImported(source.name);
    const notice = page.getByRole('button', { name: '확인', exact: true }).filter({ visible: true });
    if (await notice.count()) await notice.click();
    await page.screenshot({ path: path.join(reportDirectory, '01-imported-project.png') });
    return { ...detail, filenameExtension: '.JSON', suppliedMimeType: '' };
  });
  await check('legacy project survives complete process restart with image bytes intact', async () => {
    await shutdown();
    await launch();
    const detail = await verifyImported(source.name);
    await selectProject(source.name);
    await page.screenshot({ path: path.join(reportDirectory, '02-reopened-project.png') });
    return detail;
  });
  const destinationName = `legacy-template-target-${Date.now()}`;
  let beforeTarget;
  await check('raw legacy project imports through scene-template UI', async () => {
    await page.evaluate(async (name) => {
      const service = window.sessionService;
      await service.add(name);
      const project = await service.get(name);
      project.scenes.clear();
      project.library.clear();
      project.extraPrompt = 'Preserve this destination project setting';
      service.markDirty(name);
      await service.flushProjectNow(name);
    }, destinationName);
    await selectProject(destinationName);
    await page.waitForFunction(name => window.curSession?.name === name && !!window.curSession.selectedWorkflow, destinationName);
    beforeTarget = await savedProject(destinationName);
    const dialog = await openTemplateDialog();
    const button = await visibleButton(['파일 불러오기'], dialog);
    assert(button, 'Template file import action is missing');
    await chooseFile(button, projectBytes, 'legacy-template.JSON');
    const useButton = dialog.getByRole('button', { name: '선택한 템플릿의 씬들을 현재 프로젝트에 추가합니다', exact: true }).filter({ visible: true });
    await useButton.waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForFunction(button => !button.disabled, await useButton.elementHandle(), { timeout: 60000 });
    const templateName = (await dialog.locator('button[aria-label$=" 씬 템플릿 열기"]').first().getAttribute('aria-label')).replace(/ 씬 템플릿 열기$/, '');
    await page.screenshot({ path: path.join(reportDirectory, '03-template-imported.png') });
    const importedNotice = page.locator('.confirm-window').filter({ hasText: '씬 템플릿 불러오기를 마쳤습니다' });
    await importedNotice.getByRole('button', { name: '확인', exact: true }).click();
    await useButton.click();
    await page.getByRole('button', { name: templateName, exact: true }).click();
    return { rawProjectAccepted: true, suppliedMimeType: '', filenameExtension: '.JSON' };
  });
  await check('template application preserves all scene choices, dependencies and target settings', async () => {
    await page.waitForFunction(({ name, count }) => window.sessionService.getLoaded(name)?.scenes.size >= count, { name: destinationName, count: result.fixtures.scenes }, { timeout: 60000 });
    const saved = await savedProject(destinationName);
    const expectedNames = Object.keys(source.scenes);
    const content = Object.fromEntries(expectedNames.map((name) => [name, saved.scenes[name]]));
    assertSceneContent(content, source.scenes);
    for (const [name, library] of Object.entries(source.library)) assert.deepEqual(saved.library[name], library);
    for (const key of ['extraPrompt', 'selectedWorkflow', 'presets', 'presetShareds', 'characterPresets']) assert.deepEqual(saved[key], beforeTarget[key], `Template application changed destination ${key}`);
    await shutdown();
    await launch();
    const reopened = await savedProject(destinationName);
    for (const name of expectedNames) assert.deepEqual(reopened.scenes[name], saved.scenes[name]);
    for (const [name, library] of Object.entries(source.library)) assert.deepEqual(reopened.library[name], library);
    await selectProject(destinationName);
    await page.screenshot({ path: path.join(reportDirectory, '04-template-reopened.png') });
    return { importedScenes: expectedNames.length, promptCells: result.fixtures.promptCells, embeddedLibraries: Object.keys(source.library).length, targetSettingsUnchanged: true, survivedRestart: true };
  });
  if (pieceBytes) {
    await check('standalone prompt-piece JSON import via library UI', async () => {
      const name = `legacy-pieces-target-${Date.now()}`;
      await page.evaluate((name) => window.sessionService.add(name), name);
      await selectProject(name);
      const tab = await visibleButton(['프롬프트조각', '프롬프트 조각', '프롬프트 조각 라이브러리']);
      assert(tab, 'Prompt-piece tab is not discoverable');
      await tab.click();
      const pieceDialog = page.getByRole('dialog', { name: '프롬프트조각', exact: true });
      await pieceDialog.waitFor({ state: 'visible' });
      const importButton = await visibleButton(['와일드카드(.txt) 또는 조각그룹(.json) 불러오기', '불러오기 (.txt/.json)'], pieceDialog);
      if (importButton) await chooseFile(importButton, pieceBytes, 'legacy-pieces.JSON');
      else {
        const label = page.getByText('불러오기 (.txt/.json)', { exact: true }).filter({ visible: true });
        assert.equal(await label.count(), 1, 'Prompt-piece import label is not discoverable');
        await chooseFile(label, pieceBytes, 'legacy-pieces.JSON');
      }
      await page.waitForFunction(({ name, library }) => window.sessionService.getLoaded(name)?.library.has(library), { name, library: pieceSource.name });
      const saved = await savedProject(name);
      assert.deepEqual(saved.library[pieceSource.name], pieceSource);
      await page.screenshot({ path: path.join(reportDirectory, '05-prompt-pieces.png') });
      return { pieces: pieceSource.pieces.length, emptyPromptPreserved: pieceSource.pieces.some((piece) => piece.prompt === ''), suppliedMimeType: '', filenameExtension: '.JSON' };
    });
  }
  await check('no generation request or uncaught renderer exception', async () => {
    assert.equal(result.blockedGenerationRequests.length, 0);
    assert.equal(result.pageErrors.length, 0);
    return { generationRequests: 0, pageErrors: 0 };
  });
  result.status = 'passed';
}
run().catch(async (error) => {
  result.status = 'failed';
  result.failure = { phase, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) {
    result.visibleControlsAtFailure = await page.getByRole('button').evaluateAll((elements) => elements.filter((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0).map((element) => ({ text: element.innerText?.slice(0, 100), ariaLabel: element.getAttribute('aria-label'), title: element.getAttribute('title') }))).catch(() => []);
    await page.screenshot({ path: path.join(reportDirectory, 'failure.png'), timeout: 10000 }).catch(() => {});
  }
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
}).finally(async () => {
  try { await shutdown(); }
  catch (error) { result.shutdownError = error.message; result.status = 'failed'; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  save();
  if (process.env.KEEP_SMOKE_PROFILE !== '1') fs.rmSync(temporaryRoot, { recursive: true, force: true });
  process.stdout.write(`Legacy import result: ${path.join(reportDirectory, 'result.json')}\n`);
});
