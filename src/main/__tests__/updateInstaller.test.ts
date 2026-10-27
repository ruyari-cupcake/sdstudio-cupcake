/* eslint jest/expect-expect: ["error", { "assertFunctionNames": ["assert", "assert.*"] }] */
/** @jest-environment node */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { spawn } from 'node:child_process';
import {
  prepareWindowsUpdate,
  type WindowsUpdateOptions,
} from '../updateInstaller';

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();

  stdout = new PassThrough();

  stderr = new PassThrough();

  unreferenced = false;

  unref() {
    this.unreferenced = true;
  }
}

let root: string;
let options: WindowsUpdateOptions;
let helper: FakeHelper;
let launches: Array<{ command: string; args: readonly string[] }>;
let launch: typeof spawn;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdstudio-installer-'));
  const install = path.join(root, 'installed');
  await fs.mkdir(install);
  await fs.writeFile(path.join(install, 'Studio.exe'), 'old-program');
  await fs.writeFile(path.join(root, 'release.exe'), 'new-program');
  await fs.writeFile(path.join(root, 'helper-source.ps1'), '# fixture helper');
  options = {
    channel: 'private',
    kind: 'portable',
    artifact: {
      path: path.join(root, 'release.exe'),
      sha256: 'a'.repeat(64),
      size: 11,
    },
    target: {
      path: path.join(install, 'Studio.exe'),
      executable: 'Studio.exe',
      appId: 'io.example.studio.private',
    },
    dataRoot: path.join(root, 'chosen-data'),
    helperPath: path.join(root, 'helper-source.ps1'),
    mainProcess: {
      pid: 123,
      executablePath: path.join(root, 'extracted', 'Studio.exe'),
    },
  };
  helper = new FakeHelper();
  launches = [];
  launch = ((command: string, args: readonly string[]) => {
    launches.push({ command, args });
    queueMicrotask(() => helper.stdout.write('READY\n'));
    return helper;
  }) as unknown as typeof spawn;
});

afterEach(async () => {
  helper.stdin.destroy();
  helper.stdout.destroy();
  helper.stderr.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

it('prepares only inside the selected root, waits for explicit APPLY, and acknowledges before returning', async () => {
  let received = '';
  helper.stdin.on('data', (chunk: Buffer) => {
    received += chunk.toString();
    if (received === 'APPLY\n') helper.stdout.write('APPLY-ACCEPTED\n');
  });
  const prepared = await prepareWindowsUpdate(options, { launch });
  assert.equal(received, '');
  assert.equal(launches.length, 1);
  const { args } = launches[0];
  const planPath = args[args.indexOf('-PlanPath') + 1];
  assert.ok(
    planPath.startsWith(
      path.join(options.dataRoot, '.updates', 'private') + path.sep,
    ),
  );
  const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  assert.equal(plan.artifact.path, options.artifact.path);
  assert.equal(plan.target.path, options.target.path);
  assert.equal(plan.mainProcess.pid, 123);
  assert.equal(await fs.readFile(options.target.path, 'utf8'), 'old-program');
  await prepared.apply();
  assert.equal(received, 'APPLY\n');
});

it('cancel closes input without granting installation and rejects later APPLY', async () => {
  let received = '';
  helper.stdin.on('data', (chunk: Buffer) => {
    received += chunk.toString();
  });
  const prepared = await prepareWindowsUpdate(options, { launch });
  prepared.cancel();
  await assert.rejects(prepared.apply(), /cancel|취소/i);
  assert.equal(received, '');
  assert.equal(helper.stdin.writableEnded, true);
  assert.equal(await fs.readFile(options.target.path, 'utf8'), 'old-program');
});

it('rejects a native startup failure without a hanging preparation promise', async () => {
  const failedLaunch = (() => {
    queueMicrotask(() =>
      helper.emit('error', new Error('native launch failed')),
    );
    return helper;
  }) as unknown as typeof spawn;
  await assert.rejects(
    prepareWindowsUpdate(options, { launch: failedLaunch }),
    /native launch failed/,
  );
});

it('rejects a helper exit before ACK and reports the error to the open application', async () => {
  const errors: string[] = [];
  options.onError = (error) => {
    errors.push(error.message);
  };
  const prepared = await prepareWindowsUpdate(options, { launch });
  helper.stdin.on('data', () => helper.emit('exit', 9, null));
  await assert.rejects(prepared.apply(), /9/);
  assert.equal(errors.length, 1);
  assert.equal(await fs.readFile(options.target.path, 'utf8'), 'old-program');
});

it('coalesces repeated APPLY requests to one authorization', async () => {
  let received = '';
  helper.stdin.on('data', (chunk: Buffer) => {
    received += chunk.toString();
  });
  const prepared = await prepareWindowsUpdate(options, { launch });
  const first = prepared.apply();
  const second = prepared.apply();
  assert.equal(first, second);
  helper.stdout.write('APPLY-ACCEPTED\n');
  await Promise.all([first, second]);
  assert.equal(received, 'APPLY\n');
});

it('rejects path traversal and a download that aliases the installed executable before spawning', async () => {
  options.kind = 'folder';
  options.target.path = path.dirname(options.target.path);
  options.target.executable = '../Studio.exe';
  await assert.rejects(prepareWindowsUpdate(options, { launch }), /path|경로/i);
  assert.equal(launches.length, 0);
  options.kind = 'portable';
  options.target.path = path.join(options.target.path, 'Studio.exe');
  options.target.executable = 'Studio.exe';
  options.artifact.path = options.target.path;
  await assert.rejects(
    prepareWindowsUpdate(options, { launch }),
    /same|같|target|대상/i,
  );
  assert.equal(launches.length, 0);
});

it('does not follow an update-directory link onto a different storage root', async () => {
  await fs.mkdir(options.dataRoot);
  const redirected = path.join(root, 'other-drive');
  await fs.mkdir(redirected);
  await fs.symlink(redirected, path.join(options.dataRoot, '.updates'), 'dir');
  await assert.rejects(prepareWindowsUpdate(options, { launch }), /link|링크/i);
  assert.equal(launches.length, 0);
  assert.equal((await fs.readdir(redirected)).length, 0);
});
