import React, {
  createContext,
  useContext,
  useState,
  memo,
  useEffect,
  type ReactNode,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import { FaTimes } from 'react-icons/fa';
import { isMobile } from '../models';
import { appState } from '../models/AppService';
import {
  backStackService,
  type BackStackHandle,
} from '../models/BackStackService';
import { type GuardedCloseState, runGuardedClose } from '../models/escapeGate';
import { confirmDiscardChanges } from './backdropClose';
import useLatestRef from './useLatestRef';

// 창 배치 'cover'(기본)일 때 오버레이를 포털로 옮겨 붙일 앵커의 DOM id.
// App.tsx 도크 행의 "넓은 앵커"(프로젝트/프리셋/중앙을 감싸는 래퍼)가 이 id 를
// 갖는다 — 도크 DOM 은 옮기지 않고(재마운트 방지 계약) 오버레이만 앵커를 바꿔
// 좌우 패널 위까지 넓게 덮는다. 히스토리 도크는 앵커 밖이라 뷰어 옆에 남는다.
export const FLOAT_VIEW_WIDE_ANCHOR_ID = 'float-view-wide-anchor';

interface FloatViewEntry {
  id: number;
  component: ReactNode;
  priority: number;
  showToolbar?: boolean;
  // 이 오버레이가 자체 실행/중지 컨트롤을 갖고 있음(인페인트 편집기 등).
  // PC 하단바는 오버레이에 덮이지 않으므로, 이 플래그가 켜진 뷰가 떠 있는 동안
  // BottomBar 가 실행 컨트롤을 숨겨 버튼 중복 노출을 막는다(showToolbar 와 대칭 계약).
  ownsGenControl?: boolean;
  onEscape?: () => void;
  // 미저장 가드(2026-10-03 E2-3) — 참이면 ✕·Esc·뒤로 가기로 닫을 때 「버리고 닫을까요?」를 묻는다
  dirty?: () => boolean;
}

interface FloatViewContextProps {
  registerView: (view: FloatViewEntry) => void;
  unregisterView: (id: number) => void;
  /** 등록 뒤 children/onEscape 등이 바뀌면 갱신(2026-09-26). 부모 상태가 오버레이 내용을 바꾸는 경우를 위해. */
  updateView: (id: number, patch: Partial<Omit<FloatViewEntry, 'id'>>) => void;
}

const FloatViewContext = createContext<FloatViewContextProps | undefined>(
  undefined,
);

export const useFloatView = (): FloatViewContextProps => {
  const context = useContext(FloatViewContext);
  if (!context) {
    throw new Error('useFloatView must be used within a FloatViewProvider');
  }
  return context;
};

interface FloatViewProviderProps {
  children: ReactNode;
}

export const FloatViewProvider: React.FC<FloatViewProviderProps> = observer(
  ({ children }) => {
    const [views, setViews] = useState<FloatViewEntry[]>([]);
    // The registry owns counters and back-stack leases; React state is only a render snapshot.
    // Keeping mutations outside setState updaters makes StrictMode replay side-effect free.
    const registeredViews = useRef<Map<number, FloatViewEntry>>(new Map());
    const backHandles = useRef<Map<number, BackStackHandle>>(new Map());
    const guardStates = useRef<Map<number, GuardedCloseState>>(new Map());

    const publishViews = useCallback(() => {
      setViews(
        [...registeredViews.current.values()].sort((a, b) => b.id - a.id),
      );
    }, []);

    const requestCloseView = useCallback((id: number) => {
      const view = registeredViews.current.get(id);
      if (!view?.onEscape) return;
      let state = guardStates.current.get(id);
      if (!state) {
        state = { pending: false };
        guardStates.current.set(id, state);
      }
      const activeGuard = state;
      void runGuardedClose(
        activeGuard,
        view.dirty,
        () => {
          if (guardStates.current.get(id) === activeGuard) {
            registeredViews.current.get(id)?.onEscape?.();
          }
        },
        confirmDiscardChanges,
      );
    }, []);

    const updateView = useCallback(
      (id: number, patch: Partial<Omit<FloatViewEntry, 'id'>>) => {
        const previous = registeredViews.current.get(id);
        if (!previous) return;
        const next = { ...previous, ...patch, id };
        registeredViews.current.set(id, next);
        if (!!previous.ownsGenControl !== !!next.ownsGenControl) {
          if (next.ownsGenControl) appState.incrementGenControlOverlay();
          else appState.decrementGenControlOverlay();
        }
        publishViews();
      },
      [publishViews],
    );

    const registerView = useCallback(
      (view: FloatViewEntry) => {
        if (registeredViews.current.has(view.id)) {
          updateView(view.id, view);
          return;
        }
        registeredViews.current.set(view.id, view);
        appState.incrementFloatView();
        if (view.ownsGenControl) appState.incrementGenControlOverlay();
        backHandles.current.set(
          view.id,
          backStackService.push(() => requestCloseView(view.id)),
        );
        publishViews();
      },
      [publishViews, requestCloseView, updateView],
    );

    const releaseView = useCallback((id: number) => {
      const view = registeredViews.current.get(id);
      if (!view) return false;
      registeredViews.current.delete(id);
      appState.decrementFloatView();
      if (view.ownsGenControl) appState.decrementGenControlOverlay();
      backHandles.current.get(id)?.remove();
      backHandles.current.delete(id);
      guardStates.current.delete(id);
      return true;
    }, []);

    const unregisterView = useCallback(
      (id: number) => {
        if (releaseView(id)) publishViews();
      },
      [publishViews, releaseView],
    );

    useEffect(() => {
      const ownedViews = registeredViews.current;
      return () => {
        for (const id of ownedViews.keys()) releaseView(id);
      };
    }, [releaseView]);

    const contextValue = useMemo(
      () => ({ registerView, unregisterView, updateView }),
      [registerView, unregisterView, updateView],
    );

    const closeTopView = () => {
      const topView = views[0];
      if (topView) requestCloseView(topView.id);
    };

    // Esc 는 닫기 관문(BackStackService)이 맨 위 항목만 처리한다 — 위 registerView 의 push 가 뒤로 가기와
    // Esc 공용이다. 예전 document 리스너는 위에 뜬 모달·확인 창과 함께 닫히는 원인이라 없앴다(2026-10-03 U1·X2).

    // 안드로이드 뒤로가기 리스너를 부팅 직후 한 번 등록해 둔다. 오버레이가
    // 하나도 없을 때 뒤로가기를 눌러도 앱이 종료되지 않고 최소화되도록.
    useEffect(() => {
      backStackService.init();
    }, []);

    // showToolbar(하단 바 높이만큼 비워두기)는 하단 바가 이 오버레이가 덮는 영역 안에
    // 있는 모바일에서만 유효하다. PC 는 하단 바가 중앙 블록/도크 행 밖(전폭)이라 항상
    // 접근 가능 — 높이를 줄이면 그만큼 빈 띠만 생기므로 전체 높이를 쓴다.
    const overlay = !!views.length && (
      <div
        className={`top-0 left-0 absolute w-full z-[var(--z-float-view)] float-view ${
          views[0].showToolbar && isMobile ? 'show-toolbar' : 'h-full'
        }`}
      >
        {views.map((view) => (
          <div
            key={view.id}
            className="bg-[var(--c-surface)] h-full w-full"
            style={{ position: 'absolute', zIndex: view.id }}
          >
            <div className="flex flex-col h-full w-full">
              <div className="flex-none border-b line-color">
                {/* 전체 화면 보기의 닫기 = 좌상단 「뒤로」 ✕ 하나(모달은 우상단 — SPEC §5 닫기 규칙, 2026-10-03 E2-1) */}
                <button
                  type="button"
                  className="text-default button"
                  aria-label="뒤로"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    closeTopView();
                  }}
                >
                  <FaTimes size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-hidden">{view.component}</div>
            </div>
          </div>
        ))}
      </div>
    );

    // 창 배치(환경설정 → 레이아웃): 'cover'(기본)=넓은 앵커에 포털로 붙어 프로젝트/
    // 프리셋 패널 위로 넓게 펼침(히스토리 도크는 앵커 밖이라 옆에 남음, v4.14.0 동작) /
    // 'center'=기존처럼 중앙 콘텐츠 블록만 덮음(좌우 패널 병행 열람).
    // 모바일은 도크가 없어 항상 center 경로. 앵커 미존재 시 center 로 안전 폴백.
    const wideAnchor =
      !isMobile && appState.uiFloatViewMode !== 'center' && overlay
        ? document.getElementById(FLOAT_VIEW_WIDE_ANCHOR_ID)
        : null;

    return (
      <FloatViewContext.Provider value={contextValue}>
        {children}
        {wideAnchor ? createPortal(overlay, wideAnchor) : overlay}
      </FloatViewContext.Provider>
    );
  },
);

interface FloatViewProps {
  children: ReactNode;
  priority: number;
  showToolbar?: boolean;
  ownsGenControl?: boolean;
  onEscape?: () => void;
  dirty?: () => boolean;
}

let viewId = 0;

export const FloatView: React.FC<FloatViewProps> = memo(
  ({
    children,
    priority,
    showToolbar,
    ownsGenControl,
    onEscape,
    dirty,
  }: FloatViewProps) => {
    const { registerView, unregisterView, updateView } = useFloatView();
    const [id] = useState(() => {
      viewId += 1;
      return viewId;
    });
    const latestView = useLatestRef({
      component: children,
      priority,
      onEscape,
      dirty,
      showToolbar,
      ownsGenControl,
    });

    // Registration follows component lifetime. Updated props must not reorder the back stack.
    useEffect(() => {
      registerView({ ...latestView.current, id });
      return () => unregisterView(id);
    }, [id, latestView, registerView, unregisterView]);

    useEffect(() => {
      updateView(id, {
        component: children,
        priority,
        onEscape,
        dirty,
        showToolbar,
        ownsGenControl,
      });
    }, [
      children,
      dirty,
      id,
      onEscape,
      ownsGenControl,
      priority,
      showToolbar,
      updateView,
    ]);

    return null;
  },
);
