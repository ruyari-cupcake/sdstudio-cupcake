import React, { useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import {
  appUpdateNoticeService,
  backend,
  isMobile,
  taskQueueService,
} from '../models';
import { appState } from '../models/AppService';
import { flushApplicationStorage } from '../models/bootstrap';
import { installApplicationUpdate } from '../models/appUpdateInstall';
import { useAppUpdateState } from './AppUpdateSection';
import ModalOverlay from './ModalOverlay';

const AppUpdateDialog = observer(() => {
  const service = appUpdateNoticeService;
  useAppUpdateState(service);
  const { release } = service;
  const installing = service.phase === 'installing';
  const downloading = service.phase === 'downloading';
  const ready = service.phase === 'ready';
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (service.notificationOpen) body.current?.focus();
  }, [service.notificationOpen]);
  useEffect(() => {
    if (!installing) return undefined;
    // Modal ownership already stops application shortcuts. Also stop native
    // input while the save barrier drains, including a field focused behind it.
    const blockInput = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockInput, true);
    window.addEventListener('beforeinput', blockInput, true);
    return () => {
      window.removeEventListener('keydown', blockInput, true);
      window.removeEventListener('beforeinput', blockInput, true);
    };
  }, [installing]);
  const invoke = (action: () => Promise<unknown>) => {
    action().catch((error) => service.reportError(error));
  };
  const install = () =>
    installApplicationUpdate(service, {
      assertIdle: () => {
        if (service.settingsDirty)
          throw new Error('변경한 설정을 먼저 저장해 주세요.');
        if (
          taskQueueService.hasPendingExecution() ||
          !taskQueueService.isEmpty() ||
          appState.progressDialog ||
          (appState.exportProgress && !appState.exportProgress.completed) ||
          appState.storageLocationChange
        )
          throw new Error('진행 중인 작업이 끝나면 업데이트해 주세요.');
      },
      flush: flushApplicationStorage,
      install: async () => {
        if (!backend.updates) throw new Error('업데이트를 시작할 수 없어요.');
        await backend.updates.install();
      },
      cancel: async () => {
        await backend.updates?.cancelInstall();
      },
      mobile: isMobile,
    });
  const total = service.progress?.total || release?.asset.size || 0;
  const received = service.progress?.received ?? 0;
  const percent =
    total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;

  return (
    <ModalOverlay
      isOpen={service.notificationOpen && !!release}
      onClose={() => {
        if (!installing) service.dismiss();
      }}
      title="앱 업데이트"
      width="max-w-lg"
      zIndex="var(--z-modal-top)"
    >
      {release && (
        <div
          ref={body}
          tabIndex={-1}
          className="flex flex-col gap-4 outline-none text-default"
          aria-busy={installing || downloading}
        >
          <div>
            <p className="font-medium">새 버전이 있어요.</p>
            <p className="text-sm text-muted break-words">
              {service.current} → {release.version}
            </p>
          </div>
          {downloading && (
            <div className="flex flex-col gap-2" role="status">
              <span className="text-sm">
                {service.cancelling
                  ? '다운로드 취소 중…'
                  : `업데이트 받는 중… ${percent}%`}
              </span>
              <progress
                className="w-full"
                aria-label="업데이트 다운로드"
                value={received}
                max={total || 1}
              />
              <div>
                <button
                  type="button"
                  className="back-gray rounded px-3 py-2"
                  disabled={service.cancelling}
                  onClick={() => invoke(() => service.cancelDownload())}
                >
                  다운로드 취소
                </button>
              </div>
            </div>
          )}
          {ready && (
            <p className="text-sm">
              {isMobile
                ? '파일을 받았어요. 설치를 누르면 설치 화면이 열려요.'
                : '파일을 받았어요. 작업을 저장한 뒤 앱을 다시 시작해요.'}
            </p>
          )}
          {installing && (
            <p role="status">작업을 저장하고 업데이트를 준비하고 있어요…</p>
          )}
          {service.error && (
            <p
              className="text-sm text-red-500 whitespace-pre-wrap"
              role="alert"
            >
              {service.error}
            </p>
          )}
          {ready && service.settingsDirty && (
            <p className="text-sm text-muted">
              변경한 설정을 먼저 저장해 주세요.
            </p>
          )}
          {!installing && !downloading && (
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                className="back-sky rounded px-3 py-2 disabled:opacity-50"
                disabled={ready && service.settingsDirty}
                onClick={() =>
                  invoke(ready ? install : () => service.download())
                }
              >
                {ready
                  ? isMobile
                    ? '설치'
                    : '저장하고 다시 시작'
                  : '업데이트'}
              </button>
              <button
                type="button"
                className="back-gray rounded px-3 py-2"
                onClick={() => invoke(() => service.snooze())}
              >
                일주일 동안 보지 않기
              </button>
              <button
                type="button"
                className="back-gray rounded px-3 py-2"
                onClick={() => service.dismiss()}
              >
                나중에
              </button>
            </div>
          )}
        </div>
      )}
    </ModalOverlay>
  );
});

export default AppUpdateDialog;
