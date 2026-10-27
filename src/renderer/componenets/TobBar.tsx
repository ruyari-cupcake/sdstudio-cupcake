import { useEffect, useState } from 'react';
import {
  VscChromeMinimize,
  VscChromeMaximize,
  VscChromeRestore,
  VscChromeClose,
} from 'react-icons/vsc';
import { FaCog, FaCoins } from 'react-icons/fa';
import { observer } from 'mobx-react-lite';
import ConfigScreen from './ConfigScreen';
import SessionSelect from './SessionSelect';
import { backend, isMobile, sessionService } from '../models';
import { appState } from '../models/AppService';
import { resolveLayout } from '../models/layoutTemplates';
import OpusUsageBadge from './OpusUsageBadge';
import { normalizeTokenRotateWarning } from '../models/tokenAutoRotation';
import ModelFamilySwitch from './ModelFamilySwitch';
import useTitlebarAccount from './useTitlebarAccount';

const TobBar = observer(() => {
  const resolved = resolveLayout(appState.uiLayoutTemplate, isMobile);
  const { sessionSelectTop } = resolved;
  const projectSidebar = resolved.projectSidebar || resolved.projectStrip;
  const { loggedIn, balance } = useTitlebarAccount();
  const [warningPercent, setWarningPercent] = useState(10);
  const [isMaximized, setIsMaximized] = useState(false);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const config = await backend.getConfig();
        if (!cancelled) {
          setWarningPercent(
            normalizeTokenRotateWarning(config.multiTokenRotateWarningPercent),
          );
        }
      } catch {
        // Retain the configured warning threshold when storage is unavailable.
      }
    };
    load();
    sessionService.addEventListener('config-changed', load);
    return () => {
      cancelled = true;
      sessionService.removeEventListener('config-changed', load);
    };
  }, []);

  useEffect(() => {
    if (isMobile || !window.electron) return undefined;
    let mounted = true;
    const checkMaximized = async () => {
      try {
        const maximized = await window.electron.ipcRenderer.invoke(
          'window-is-maximized',
        );
        if (mounted) setIsMaximized(maximized);
      } catch {
        // Keep the last observed state if the native window is closing.
      }
    };
    checkMaximized();
    window.addEventListener('resize', checkMaximized);
    return () => {
      mounted = false;
      window.removeEventListener('resize', checkMaximized);
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      if ((event as CustomEvent).detail?.action === 'open-config') {
        setSettings(true);
      }
    };
    window.addEventListener('shortcut-action', handler);
    return () => window.removeEventListener('shortcut-action', handler);
  }, []);

  const reportWindowError = (error: unknown) => {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    appState.pushMessage(`창 제어에 실패했습니다: ${message}`);
  };
  const handleMinimize = async () => {
    try {
      await window.electron?.ipcRenderer.invoke('window-minimize');
    } catch (error) {
      reportWindowError(error);
    }
  };
  const handleMaximize = async () => {
    const { electron } = window;
    if (!electron) return;
    try {
      await electron.ipcRenderer.invoke('window-maximize');
      const maximized = await electron.ipcRenderer.invoke(
        'window-is-maximized',
      );
      setIsMaximized(maximized);
    } catch (error) {
      reportWindowError(error);
    }
  };
  const handleClose = async () => {
    try {
      await window.electron?.ipcRenderer.invoke('window-close');
    } catch (error) {
      reportWindowError(error);
    }
  };

  const creditsText = balance.value?.toLocaleString('ko-KR') ?? '—';
  const creditsLabel = balance.value === undefined ? '미확인' : creditsText;
  let creditsTitle = `Anlas ${creditsLabel}`;
  if (balance.refreshing) {
    creditsTitle += ' · 확인 중';
    if (balance.value !== undefined) creditsTitle += ' · 이전 조회값';
  } else if (balance.state === 'error' || balance.state === 'stale') {
    creditsTitle += ' · 조회 실패';
    if (balance.value !== undefined) creditsTitle += ' · 이전 조회값';
  }

  const mobileSettingsButton = (
    <button
      type="button"
      className="icon-button flex-none"
      aria-label="환경설정"
      onClick={() => setSettings(true)}
    >
      <FaCog size={18} aria-hidden="true" />
    </button>
  );
  const mobileAccountBadge = loggedIn ? (
    <OpusUsageBadge
      credits={balance.value ?? null}
      warningPercent={warningPercent}
      inline
    />
  ) : (
    <span className="round-tag back-red text-sm !px-2 !py-1">로그인필요</span>
  );

  return (
    <div
      className={`zone-bar titlebar-drag flex border-b line-color px-3 py-2 items-center select-none gap-2${isMobile ? '' : ' flex-wrap lg:flex-nowrap'}`}
    >
      <div className="titlebar-no-drag gap-3 hidden lg:flex text-sky-500 font-bold dark:text-white">
        SDStudio
      </div>

      {!isMobile && (
        <div className="ml-auto order-1 flex items-center gap-2 flex-none titlebar-no-drag">
          <div className="hidden md:block">
            <ModelFamilySwitch />
          </div>
          <button
            type="button"
            className="btn account-status-control back-sky text-sm"
            aria-label="환경설정"
            onClick={() => setSettings(true)}
          >
            <FaCog size={16} className="lg:hidden" aria-hidden="true" />
            <span className="hidden lg:inline">환경설정</span>
          </button>
        </div>
      )}

      {isMobile && appState.uiToolbar.classic && (
        <div className="md:hidden flex flex-col items-center gap-1 titlebar-no-drag flex-none">
          <button
            type="button"
            className="round-button back-sky text-sm px-3 py-1 min-w-0 min-h-0"
            onClick={() => setSettings(true)}
          >
            환경설정
          </button>
          {loggedIn ? (
            <OpusUsageBadge
              credits={balance.value ?? null}
              warningPercent={warningPercent}
            />
          ) : (
            <span className="round-tag back-red text-sm !px-3 !py-1">
              로그인필요
            </span>
          )}
        </div>
      )}

      {/* Narrow desktop windows give project navigation its own full-width row.
          Its unused space stays draggable; only the controls opt out. */}
      {!projectSidebar && (
        <div
          className={`${sessionSelectTop ? '' : 'ml-auto '}${
            isMobile
              ? 'flex-1'
              : 'order-3 w-full flex-none lg:order-none lg:w-auto lg:flex-1'
          } min-w-0 ${sessionSelectTop ? 'block' : 'block md:hidden'}`}
        >
          <SessionSelect
            mobileLead={
              <>
                {mobileSettingsButton}
                <span className="flex-none">{mobileAccountBadge}</span>
              </>
            }
          />
        </div>
      )}

      {!isMobile && (
        <>
          <div
            role="group"
            aria-label="계정 잔액 및 생성 할당량"
            className="titlebar-account-status titlebar-no-drag order-1"
          >
            {loggedIn ? (
              <>
                <output
                  className="account-status-control titlebar-anlas back-yellow tabular-nums text-sm gap-1.5"
                  aria-label={`Anlas ${creditsLabel}`}
                  aria-live="off"
                  title={creditsTitle}
                >
                  <FaCoins size={15} aria-hidden="true" className="flex-none" />
                  <span className="titlebar-anlas-value">{creditsText}</span>
                </output>
                <OpusUsageBadge warningPercent={warningPercent} />
              </>
            ) : (
              <span
                className="account-status-control back-red text-sm"
                title="환경설정에서 로그인하세요"
              >
                로그인필요
              </span>
            )}
          </div>
          <div
            role="group"
            aria-label="창 제어"
            className="titlebar-no-drag order-2 flex flex-none items-center ml-2 -mr-1"
          >
            <button
              type="button"
              className="window-control-btn"
              aria-label="최소화"
              title="최소화"
              onClick={handleMinimize}
            >
              <VscChromeMinimize size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="window-control-btn"
              aria-label={isMaximized ? '이전 크기로' : '최대화'}
              title={isMaximized ? '이전 크기로' : '최대화'}
              onClick={handleMaximize}
            >
              {isMaximized ? (
                <VscChromeRestore size={16} aria-hidden="true" />
              ) : (
                <VscChromeMaximize size={16} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="window-control-btn window-control-close"
              aria-label="닫기"
              title="닫기"
              onClick={handleClose}
            >
              <VscChromeClose size={16} aria-hidden="true" />
            </button>
          </div>
        </>
      )}

      {settings && (
        <ConfigScreen
          onSave={() => setSettings(false)}
          onClose={() => setSettings(false)}
        />
      )}
    </div>
  );
});

export default TobBar;
