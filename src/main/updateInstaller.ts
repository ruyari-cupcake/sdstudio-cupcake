import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

export interface WindowsUpdateOptions {
  channel: 'public' | 'private';
  kind: 'portable' | 'folder';
  artifact: { path: string; sha256: string; size: number };
  target: { path: string; appId: string; executable: string };
  dataRoot: string;
  helperPath: string;
  mainProcess?: { pid: number; executablePath: string };
  onError?: (error: Error) => void;
}

export interface PreparedWindowsUpdate {
  apply(): Promise<void>;
  cancel(): void;
  resultPath: string;
}

export interface WindowsInstallerDependencies {
  launch: typeof spawn;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function requireAbsolute(value: string): void {
  if (!value || !path.isAbsolute(value)) {
    throw new Error('업데이트 파일 경로는 절대 경로여야 해요.');
  }
}

function requireRelativeExecutable(value: string): void {
  const segments = value.split(/[\\/]/);
  if (
    !value ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    segments.some(
      (segment) => !segment || segment === '.' || segment === '..',
    ) ||
    /[:<>"|?*]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    path.extname(value).toLowerCase() !== '.exe'
  ) {
    throw new Error('업데이트 실행 파일 경로를 확인할 수 없어요.');
  }
}

async function assertNoLinks(filePath: string): Promise<void> {
  let current = path.resolve(filePath);
  for (;;) {
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error('업데이트 경로에 다른 폴더로 이어지는 링크가 있어요.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function validateOptions(options: WindowsUpdateOptions): void {
  if (
    !['public', 'private'].includes(options.channel) ||
    !['portable', 'folder'].includes(options.kind) ||
    !/^[a-f\d]{64}$/i.test(options.artifact.sha256) ||
    !Number.isSafeInteger(options.artifact.size) ||
    options.artifact.size <= 0 ||
    !options.target.appId
  ) {
    throw new Error('업데이트 파일 정보를 확인할 수 없어요.');
  }
  [
    options.artifact.path,
    options.target.path,
    options.dataRoot,
    options.helperPath,
  ].forEach(requireAbsolute);
  requireRelativeExecutable(options.target.executable);
  const executablePath =
    options.kind === 'portable'
      ? options.target.path
      : path.join(options.target.path, options.target.executable);
  if (samePath(options.artifact.path, executablePath)) {
    throw new Error('다운로드한 파일과 교체할 대상이 같아요.');
  }
  if (
    options.kind === 'portable' &&
    options.target.executable.toLowerCase() !==
      path.basename(options.target.path).toLowerCase()
  ) {
    throw new Error('업데이트 실행 파일 경로가 대상과 달라요.');
  }
  const main = options.mainProcess;
  if (main) {
    requireAbsolute(main.executablePath);
    if (!Number.isSafeInteger(main.pid) || main.pid <= 0) {
      throw new Error('실행 중인 프로그램을 확인할 수 없어요.');
    }
  }
}

/**
 * The helper is deliberately outside the executable being replaced. It receives
 * permission only after the caller's normal save/close barrier has succeeded.
 * APPLY resolves on the helper's receipt; the helper then waits on process handles
 * before touching installed files. No timer can turn an unfinished save into quit.
 */
export async function prepareWindowsUpdate(
  options: WindowsUpdateOptions,
  dependencies: WindowsInstallerDependencies = { launch: spawn },
): Promise<PreparedWindowsUpdate> {
  validateOptions(options);
  const mainProcess = options.mainProcess ?? {
    pid: process.pid,
    executablePath: process.execPath,
  };
  const updatesPath = path.join(options.dataRoot, '.updates', options.channel);
  await Promise.all([
    assertNoLinks(updatesPath),
    assertNoLinks(options.artifact.path),
    assertNoLinks(options.helperPath),
    assertNoLinks(options.target.path),
  ]);
  await fs.mkdir(updatesPath, { recursive: true });
  await assertNoLinks(updatesPath);
  const workspace = await fs.mkdtemp(path.join(updatesPath, 'install-'));
  const helperPath = path.join(workspace, 'update-helper.ps1');
  const planPath = path.join(workspace, 'plan.json');
  const resultPath = path.join(workspace, 'result.json');
  await fs.copyFile(options.helperPath, helperPath);
  await fs.writeFile(
    planPath,
    JSON.stringify({
      schema: 1,
      channel: options.channel,
      kind: options.kind,
      artifact: options.artifact,
      target: options.target,
      workspace,
      mainProcess,
    }),
    { encoding: 'utf8', flag: 'wx' },
  );

  const child = dependencies.launch(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath,
      '-PlanPath',
      planPath,
    ],
    {
      cwd: workspace,
      detached: true,
      windowsHide: true,
      stdio: 'pipe',
    },
  ) as ChildProcessWithoutNullStreams;

  return new Promise<PreparedWindowsUpdate>((resolve, reject) => {
    let state:
      | 'preparing'
      | 'ready'
      | 'applying'
      | 'accepted'
      | 'cancelled'
      | 'failed' = 'preparing';
    let applyPromise: Promise<void> | undefined;
    let resolveApply: (() => void) | undefined;
    let rejectApply: ((error: Error) => void) | undefined;
    let stderr = '';
    const lines = createInterface({ input: child.stdout });

    const fail = (reason: unknown) => {
      if (['accepted', 'cancelled', 'failed'].includes(state)) return;
      const wasPreparing = state === 'preparing';
      state = 'failed';
      const error =
        reason instanceof Error ? reason : new Error(String(reason));
      child.stdin.end();
      if (wasPreparing) reject(error);
      rejectApply?.(error);
      options.onError?.(error);
    };

    child.once('error', fail);
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', fail);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('exit', (code, signal) => {
      fail(
        new Error(
          `업데이트 도우미가 종료됐어요 (${code ?? signal ?? 'unknown'}).${stderr ? ` ${stderr.trim()}` : ''}`,
        ),
      );
      lines.close();
    });

    const prepared: PreparedWindowsUpdate = {
      resultPath,
      apply() {
        if (applyPromise) return applyPromise;
        if (state !== 'ready') {
          return Promise.reject(
            new Error(
              state === 'cancelled'
                ? '업데이트를 취소했어요.'
                : '업데이트 도우미가 준비되지 않았어요.',
            ),
          );
        }
        state = 'applying';
        applyPromise = new Promise<void>((_resolve, _reject) => {
          resolveApply = _resolve;
          rejectApply = _reject;
        });
        child.stdin.write('APPLY\n', (error) => {
          if (error) fail(error);
        });
        return applyPromise;
      },
      cancel() {
        if (state !== 'ready') return;
        state = 'cancelled';
        child.stdin.end();
      },
    };

    lines.on('line', (line: string) => {
      if (line === 'READY' && state === 'preparing') {
        state = 'ready';
        resolve(prepared);
      } else if (line === 'APPLY-ACCEPTED' && state === 'applying') {
        state = 'accepted';
        resolveApply?.();
        child.stdin.end();
        // Once acknowledged, this process may exit. The detached helper records
        // installation/rollback in result.json and relaunches the right program.
        lines.close();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      } else if (line.startsWith('ERROR ')) {
        try {
          const detail: { message?: string } = JSON.parse(line.slice(6));
          fail(new Error(detail.message || '업데이트 준비에 실패했어요.'));
        } catch (error) {
          fail(error);
        }
      }
    });
    lines.on('close', () => {
      if (['preparing', 'ready', 'applying'].includes(state)) {
        fail(new Error('업데이트 도우미의 연결이 종료됐어요.'));
      }
    });
  });
}
