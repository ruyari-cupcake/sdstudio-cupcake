import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaTimes } from 'react-icons/fa';
import { observer } from 'mobx-react-lite';
import { loginService, opusUsageService } from '../models';
import { appState } from '../models/AppService';
import { backStackService } from '../models/BackStackService';
import { presentOpusUsage } from '../models/opusUsagePresentation';
import OpusUsageMeter, { OpusUsageBar, OpusUsageHelp } from './OpusUsageMeter';

export function useOpusUsage() {
  const [, redraw] = useState(0);
  useEffect(() => {
    const onChange = () => redraw((n) => n + 1);
    opusUsageService.addEventListener('change', onChange);
    loginService.addEventListener('token-profiles-change', onChange);
    return () => {
      opusUsageService.removeEventListener('change', onChange);
      loginService.removeEventListener('token-profiles-change', onChange);
    };
  }, []);
  return opusUsageService;
}

const OpusUsageBadge = observer(
  ({
    credits = undefined,
    warningPercent = 10,
    inline = false,
  }: {
    credits?: number | null;
    warningPercent?: number;
    // 모바일 상단 바 1줄째용 일렬 표기: [Anlas | 할당량]+하단 3px 막대, 라운드 사각형 높이 28px.
    // 세로 3단 알약(49×36)은 선택기(34px)보다 높고 칸이 빡빡해 목업 비교 후 교체(2026-09-20).
    // 클래식 툴바의 세로 배치는 기존 세로 3단을 유지한다(inline 미전달).
    inline?: boolean;
  }) => {
    const usage = useOpusUsage();
    const mobile = credits !== undefined;
    const [open, setOpen] = useState(false);
    const [switchingId, setSwitchingId] = useState<string>();
    const switchingRef = useRef(false);
    const [switchError, setSwitchError] = useState('');
    const [, redrawProfiles] = useState(0);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const downOnBackdrop = useRef(false);
    const [position, setPosition] = useState({ left: 8, top: 8 });
    const warning = warningPercent;
    const view = presentOpusUsage(usage.status, warning);
    const busy = usage.refreshing || !!switchingId;
    const profiles = loginService.listTokenProfiles();
    const activeName = profiles.find(
      (p) => p.id === loginService.activeProfileId,
    )?.name;
    const creditsText =
      typeof credits === 'number' ? credits.toLocaleString() : '—';
    const creditsLabel = credits === null ? '미확인' : credits;
    let buttonClass = `account-status-control account-quota-control back-${view.tone}`;
    let quotaLabelClass = 'account-quota-label text-default';
    if (mobile) {
      buttonClass = 'round-tag inline-grid leading-none align-middle !p-0';
      quotaLabelClass = `back-${view.tone} px-2 text-[11px] leading-[14px]`;
      if (inline) {
        buttonClass =
          'relative inline-flex items-stretch align-middle rounded-lg h-7 !p-0 text-xs leading-[25px] whitespace-nowrap';
        quotaLabelClass = `back-${view.tone} px-[7px]`;
      }
    }
    let quotaTitle = 'Opus 무료 생성 할당량';
    if (usage.status?.opusSubscribed === false) {
      quotaTitle = 'Opus 미구독 · 무료 할당량 대상 아님';
    } else if (usage.state === 'error') {
      quotaTitle += ' · 조회 실패';
    } else if (usage.refreshing) {
      quotaTitle += ' · 확인 중';
    } else if (usage.state === 'stale') {
      quotaTitle += ' · 이전 조회값';
    }

    useEffect(() => {
      if (!open) return undefined;
      let cancelled = false;
      setSwitchError('');
      // Read saved profile labels only. Opening this panel must not query all
      // accounts or change the currently active token.
      const loadProfiles = async () => {
        try {
          await loginService.loadTokenProfiles();
          if (!cancelled) redrawProfiles((v) => v + 1);
        } catch {
          if (!cancelled) {
            setSwitchError('저장된 토큰 목록을 불러오지 못했습니다');
          }
        }
      };
      loadProfiles();
      return () => {
        cancelled = true;
      };
    }, [open]);

    const switchProfile = async (id: string) => {
      if (switchingRef.current || id === loginService.activeProfileId) return;
      switchingRef.current = true;
      setSwitchingId(id);
      setSwitchError('');
      try {
        await loginService.activateTokenProfile(id);
        // The top bar login event invalidates the old cache. Refresh immediately
        // without waiting for Anlas; simultaneous requests are coalesced.
        await usage.refresh();
      } catch (e: any) {
        setSwitchError(e.message || '계정을 전환하지 못했습니다');
      } finally {
        switchingRef.current = false;
        setSwitchingId(undefined);
      }
    };

    useLayoutEffect(() => {
      if (!open) return undefined;
      const place = () => {
        const anchor = buttonRef.current?.getBoundingClientRect();
        const panel = panelRef.current?.getBoundingClientRect();
        if (!anchor || !panel) return;
        setPosition({
          left: Math.max(
            8,
            Math.min(
              anchor.right - panel.width,
              window.innerWidth - panel.width - 8,
            ),
          ),
          top: Math.max(
            8,
            Math.min(anchor.bottom + 8, window.innerHeight - panel.height - 8),
          ),
        });
      };
      place();
      const resize = new ResizeObserver(place);
      if (panelRef.current) resize.observe(panelRef.current);
      window.addEventListener('resize', place);
      return () => {
        resize.disconnect();
        window.removeEventListener('resize', place);
      };
    }, [open]);

    useEffect(() => {
      if (!open) return undefined;
      appState.incrementModalOverlay();
      const close = () => {
        setOpen(false);
        buttonRef.current?.focus();
      };
      const handle = backStackService.push(close);
      const keyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        if (e.key === 'Tab') {
          const items = panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), summary',
          );
          if (!items?.length) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };
      window.addEventListener('keydown', keyDown, true);
      panelRef.current?.querySelector('button')?.focus();
      return () => {
        handle.remove();
        window.removeEventListener('keydown', keyDown, true);
        appState.decrementModalOverlay();
      };
    }, [open]);

    const portalHost =
      buttonRef.current?.closest<HTMLElement>('[data-app-theme-root]') ??
      document.body;
    return (
      <>
        <button
          type="button"
          ref={buttonRef}
          className={`btn titlebar-no-drag overflow-hidden text-center tabular-nums ${buttonClass}`}
          aria-label={`${mobile ? `Anlas ${creditsLabel}, ` : ''}${usage.status?.opusSubscribed === false ? 'Opus 미구독' : `무료 생성 할당량 ${view.text}`}, 상세 보기`}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={quotaTitle}
          onClick={() => setOpen(!open)}
        >
          {mobile && (
            <span
              className={`back-yellow ${inline ? 'px-[7px]' : 'px-2 text-xs leading-4'}`}
            >
              {creditsText}
            </span>
          )}
          <span className={`${quotaLabelClass} whitespace-nowrap`}>
            {!mobile && <span className="account-quota-caption">할당량</span>}
            <span className="flex-none">{view.text}</span>
          </span>
          <OpusUsageBar
            status={usage.status}
            warningPercent={warning}
            line={mobile && inline}
          />
        </button>
        {open &&
          createPortal(
            <div
              role="presentation"
              className="fixed inset-0 titlebar-no-drag"
              style={{ zIndex: 'var(--z-modal)' }}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => {
                e.stopPropagation();
                downOnBackdrop.current = e.target === e.currentTarget;
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (e.target === e.currentTarget && downOnBackdrop.current) {
                  setOpen(false);
                  buttonRef.current?.focus();
                }
                downOnBackdrop.current = false;
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label="Opus 무료 생성 할당량"
                className="fixed w-80 max-w-[calc(100vw-16px)] max-h-[80vh] overflow-auto rounded-lg r-popover border line-color bg-[var(--c-zone)] shadow-2xl p-4 text-default space-y-3"
                style={position}
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-sm">
                    Opus 무료 생성 할당량
                  </h2>
                  <button
                    type="button"
                    className="btn btn-ghost text-muted rounded p-1"
                    aria-label="닫기"
                    onClick={() => {
                      setOpen(false);
                      buttonRef.current?.focus();
                    }}
                  >
                    <FaTimes size={14} />
                  </button>
                </div>
                <div className="text-xs text-muted truncate">
                  {switchingId
                    ? '계정 전환 중…'
                    : activeName || '현재 로그인 계정'}
                </div>
                <OpusUsageMeter
                  status={switchingId ? undefined : usage.status}
                  checkedAt={switchingId ? 0 : usage.fetchedAt}
                  warningPercent={warning}
                  loading={!!switchingId || (busy && !usage.status)}
                  stale={usage.state === 'stale'}
                  error={usage.state === 'error' ? '조회 실패' : undefined}
                />
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="btn back-sky rounded px-3 py-1.5 text-xs"
                    disabled={busy}
                    onClick={() => {
                      usage.refresh(true, { fresh: true });
                    }}
                  >
                    {busy ? '확인 중…' : '새로고침'}
                  </button>
                </div>
                {profiles.length >= 2 && (
                  <div className="border-t line-color pt-3 space-y-2">
                    <h3 className="text-xs font-semibold text-body">
                      계정 전환
                    </h3>
                    <div className="space-y-1 max-h-40 overflow-auto">
                      {profiles.map((profile) => {
                        const active =
                          profile.id === loginService.activeProfileId;
                        let actionLabel = active ? '사용 중' : '전환';
                        if (switchingId === profile.id)
                          actionLabel = '전환 중…';
                        return (
                          <div
                            key={profile.id}
                            className="flex items-center gap-2 rounded-lg bg-[var(--c-surface-2)] px-2 py-1.5"
                          >
                            <span
                              className="min-w-0 flex-1 truncate text-sm"
                              title={profile.name}
                            >
                              {profile.name}
                            </span>
                            <button
                              type="button"
                              className={`btn rounded px-3 py-1.5 text-xs flex-none ${active ? 'back-green' : 'back-sky'}`}
                              aria-label={`${profile.name}으로 전환`}
                              disabled={!!switchingId || active}
                              onClick={() => {
                                switchProfile(profile.id);
                              }}
                            >
                              {actionLabel}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {switchError && (
                  <p
                    role="alert"
                    className="back-red rounded px-2 py-1.5 text-xs"
                  >
                    {switchError}
                  </p>
                )}
                <OpusUsageHelp />
              </div>
            </div>,
            portalHost,
          )}
      </>
    );
  },
);

export default OpusUsageBadge;
