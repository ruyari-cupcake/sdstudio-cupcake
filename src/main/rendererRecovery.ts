import type { BrowserWindow, MessageBoxOptions } from 'electron';

type RecoveryWindow = Pick<
  BrowserWindow,
  'webContents' | 'isDestroyed' | 'close'
>;

interface RendererRecoveryDependencies {
  releaseWatches: () => Promise<void>;
  prompt: (options: MessageBoxOptions) => Promise<{ response: number }>;
  report: (message: string, detail?: unknown) => void;
}

/** Renderer death needs a native prompt because React cannot render after a process crash. */
export function attachRendererRecovery(
  win: RecoveryWindow,
  deps: RendererRecoveryDependencies,
): { canSave: () => boolean } {
  let crashed = false;
  let prompting = false;

  win.webContents.on(
    'did-start-navigation',
    (_event, _url, isInPlace, isMainFrame) => {
      // Reload keeps the same webContents id but destroys the React tree
      // without running effect cleanup. A same-document route keeps its leases.
      if (!isInPlace && isMainFrame && !win.isDestroyed()) {
        deps
          .releaseWatches()
          .catch((error) =>
            deps.report('Release navigating renderer image watches', error),
          );
      }
    },
  );
  win.webContents.on('did-finish-load', () => {
    crashed = false;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    if (win.isDestroyed()) return;
    crashed = true;
    deps.report('Renderer process gone', details);
    deps
      .releaseWatches()
      .catch((error) => deps.report('Release renderer image watches', error));
    if (prompting) return;
    prompting = true;
    void Promise.resolve()
      .then(() =>
        deps.prompt({
          type: 'error',
          title: '화면 복구',
          message: '앱의 화면 프로세스가 종료되었습니다.',
          detail: `원인: ${details.reason} (코드 ${details.exitCode})\n화면을 다시 열면 저장된 프로젝트를 다시 열 수 있습니다. 진행 중이던 생성은 완료 여부를 확인한 후 다시 실행해 주세요.`,
          buttons: ['화면 다시 열기', '창 닫기'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        }),
      )
      .then(({ response }) => {
        if (!win.isDestroyed()) {
          if (response === 0) win.webContents.reload();
          else win.close();
        }
        return undefined;
      })
      .catch((error) => {
        deps.report('Renderer recovery prompt failed', error);
      })
      .finally(() => {
        prompting = false;
      });
  });

  // A dead renderer cannot acknowledge the normal save-before-close protocol.
  return { canSave: () => !crashed };
}
