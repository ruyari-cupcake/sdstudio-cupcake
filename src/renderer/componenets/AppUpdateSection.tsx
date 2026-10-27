import React, { useEffect, useReducer, useState } from 'react';
import { appUpdateNoticeService, backend } from '../models';
import type { AppUpdateNoticeService } from '../models/AppUpdateNoticeService';
import { APP_RELEASE_CHANNEL } from '../../shared/appIdentity';

export function useAppUpdateState(service: AppUpdateNoticeService): void {
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const changed = () => redraw();
    service.addEventListener('changed', changed);
    // Read the service after subscribing: startup may have completed before the
    // settings pane or the application dialog mounted.
    changed();
    service.initialize().catch((error) => service.reportError(error));
    return () => service.removeEventListener('changed', changed);
  }, [service]);
}

export default function AppUpdateSection({
  service = appUpdateNoticeService,
}: {
  service?: AppUpdateNoticeService;
} = {}) {
  useAppUpdateState(service);
  const [token, setToken] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const { state } = service;
  const busy =
    service.connecting ||
    service.phase === 'checking' ||
    service.phase === 'downloading' ||
    service.phase === 'installing';
  const invoke = (action: () => Promise<unknown>) => {
    action().catch((error) => service.reportError(error));
  };
  const connect = async () => {
    await service.connect(token.trim());
    setToken('');
    await service.checkForUpdate();
  };

  return (
    <section
      className="flex flex-col gap-2 text-default"
      aria-label="앱 업데이트"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">앱 업데이트</span>
        <span className="text-sm text-muted">
          {state?.channel === 'public' ? '공개판' : '비공개판'}
          {state?.version ? ` · ${state.version}` : ''}
        </span>
      </div>
      {state?.supported === false && (
        <p className="text-sm text-muted">
          이 환경에서는 자동 업데이트를 사용할 수 없어요.
        </p>
      )}
      {state?.supported && state.channel === 'private' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm">
              {state.connected
                ? '비공개 업데이트 연결됨'
                : '비공개 업데이트 연결'}
            </span>
            <button
              type="button"
              className="rounded-full border line-color w-6 h-6 text-sm"
              aria-label="비공개 업데이트 연결 도움말"
              aria-expanded={showHelp}
              onClick={() => setShowHelp(!showHelp)}
            >
              ?
            </button>
          </div>
          {showHelp && (
            <div className="text-sm text-muted" role="note">
              <p>
                GitHub에서 {APP_RELEASE_CHANNEL.repo} 저장소를 읽을 수 있는
                토큰을 만들어 한 번 넣어 주세요. 권한은 Contents의 Read-only면
                돼요.
              </p>
              <button
                type="button"
                className="underline mt-1"
                onClick={() =>
                  backend.openWebPage(
                    'https://github.com/settings/personal-access-tokens/new',
                  )
                }
              >
                GitHub에서 토큰 만들기
              </button>
            </div>
          )}
          {state.connected ? (
            <div>
              <button
                type="button"
                className="back-gray rounded px-3 py-1.5 text-sm disabled:opacity-50"
                disabled={busy || service.phase === 'ready'}
                onClick={() => invoke(() => service.disconnect())}
              >
                연결 해제
              </button>
            </div>
          ) : (
            <div className="flex gap-2 flex-wrap">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="GitHub 업데이트 토큰"
                placeholder="GitHub 토큰"
                className="back-gray rounded px-3 py-1.5 min-w-0 flex-1"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={busy}
              />
              <button
                type="button"
                className="back-sky rounded px-3 py-1.5 disabled:opacity-50"
                disabled={busy || !token.trim()}
                onClick={() => invoke(connect)}
              >
                {service.connecting ? '연결 중…' : '연결'}
              </button>
            </div>
          )}
        </div>
      )}
      {state?.supported && (
        <div className="flex gap-2 items-center flex-wrap">
          <button
            type="button"
            className="back-gray rounded px-3 py-1.5 disabled:opacity-50"
            disabled={busy || (state.channel === 'private' && !state.connected)}
            onClick={() => invoke(() => service.checkForUpdate())}
          >
            {service.phase === 'checking' ? '확인 중…' : '업데이트 확인'}
          </button>
          {service.release && (
            <button
              type="button"
              className="back-sky rounded px-3 py-1.5"
              onClick={() => service.show()}
            >
              {service.phase === 'ready'
                ? '업데이트 설치'
                : service.phase === 'downloading'
                  ? '다운로드 보기'
                  : `새 버전 ${service.release.version}`}
            </button>
          )}
          {service.checked && !service.release && !service.error && (
            <span className="text-sm text-muted">최신 버전이에요.</span>
          )}
        </div>
      )}
      {state && state.snoozedUntil > Date.now() && (
        <p className="text-sm text-muted">
          {new Date(state.snoozedUntil).toLocaleDateString()}까지 자동 알림을
          쉬어요. 위 버튼으로는 언제든 확인할 수 있어요.
        </p>
      )}
      {service.error && (
        <p className="text-sm text-red-500" role="alert">
          {service.error}
        </p>
      )}
    </section>
  );
}
