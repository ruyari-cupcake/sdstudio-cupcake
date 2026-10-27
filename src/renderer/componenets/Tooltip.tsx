import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  type ReactNode,
} from 'react';
import ReactDOM from 'react-dom';

interface TooltipProps {
  content: string;
  children: ReactNode;
  delay?: number;
  placement?: 'top' | 'bottom';
}

// 터치 계약 상수. TOUCH_HOLD_MS 는 전역 DndProvider 의 delayTouchStart(400ms)와 같은 값.
export const TOUCH_HOLD_MS = 400;
export const TOUCH_LINGER_MS = 3000;
const TOUCH_SLOP_PX = 10;

// 접근성(2026-10-04 I1): 자식이 버튼·클릭 요소(DOM)이고 이름(aria-label/aria-labelledby)이 없으면
// 툴팁 문구를 aria-label 로 붙인다 — 아이콘만 있는 버튼도 화면 낭독기·테스트가 이름으로 찾는다.
// 자식이 직접 정한 aria-label 이 항상 우선이고, 컴포넌트 자식(SceneQueueMenu 등)에는 손대지 않는다.
const CLICKABLE_TAGS = new Set(['button', 'a', 'label', 'summary']);
export function withTooltipAriaLabel(
  children: ReactNode,
  content: string,
): ReactNode {
  if (!content || !React.isValidElement(children)) return children;
  const el = children as React.ReactElement<Record<string, unknown>>;
  if (typeof el.type !== 'string') return children;
  const p = el.props;
  if (p['aria-label'] != null || p['aria-labelledby'] != null) return children;
  const clickable =
    CLICKABLE_TAGS.has(el.type) ||
    typeof p.onClick === 'function' ||
    p.role === 'button';
  if (!clickable) return children;
  return React.cloneElement(el, { 'aria-label': content });
}

const TooltipPortal = ({
  content,
  triggerRect,
  placement,
}: {
  content: string;
  triggerRect: DOMRect;
  placement: 'top' | 'bottom';
}) => {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const tt = el.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // horizontal center aligned to trigger
    let left = triggerRect.left + triggerRect.width / 2 - tt.width / 2;
    if (left < 6) left = 6;
    if (left + tt.width > winW - 6) left = winW - 6 - tt.width;

    // vertical: prefer placement, flip if needed
    let top: number;
    if (placement === 'top') {
      top = triggerRect.top - tt.height - 6;
      if (top < 6) top = triggerRect.bottom + 6;
    } else {
      top = triggerRect.bottom + 6;
      if (top + tt.height > winH - 6) top = triggerRect.top - tt.height - 6;
    }

    setPos({ left, top });
  }, [triggerRect, placement]);

  return ReactDOM.createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="fixed pointer-events-none whitespace-pre-wrap max-w-xs tooltip-animate"
      style={{
        zIndex: 'var(--z-tooltip)',
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : -9999,
      }}
    >
      <div className="bg-gray-900 dark:bg-gray-800 text-white text-sm px-2.5 py-1.5 rounded-md shadow-lg border border-gray-600 dark:border-gray-500">
        {content}
      </div>
    </div>,
    document.body,
  );
};

function Tooltip({
  content,
  children,
  delay = 200,
  placement = 'bottom',
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const [activePlacement, setActivePlacement] = useState(placement);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const placementRef = useRef(placement);
  // 터치로 띄운 툴팁은 손을 뗀 뒤에도 잠시 유지한다(pinned). 터치 직후 브라우저가 합성하는
  // mouseenter/mousedown/mouseleave 는 무시해야 유지가 깨지지 않는다.
  const [pinned, setPinned] = useState(false);
  const lastTouchRef = useRef(0);
  const touchStartRef = useRef<{ at: number; x: number; y: number } | null>(
    null,
  );
  const suppressClickRef = useRef(false);
  const suppressResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSyntheticMouse = () => Date.now() - lastTouchRef.current < 1000;

  const showTooltip = useCallback(() => {
    const el = triggerRef.current;
    if (el) {
      const child = el.firstElementChild as HTMLElement | null;
      const rect = child
        ? child.getBoundingClientRect()
        : el.getBoundingClientRect();
      setTriggerRect(rect);
      setActivePlacement(placementRef.current);
      setVisible(true);
    }
  }, []);

  const show = useCallback(() => {
    if (isSyntheticMouse()) return;
    placementRef.current = placement;
    timerRef.current = setTimeout(showTooltip, delay);
  }, [delay, showTooltip, placement]);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (touchHideRef.current) {
      clearTimeout(touchHideRef.current);
      touchHideRef.current = null;
    }
    setVisible(false);
    setPinned(false);
  }, []);

  const hideFromMouse = useCallback(() => {
    if (isSyntheticMouse()) return;
    hide();
  }, [hide]);

  // 모바일 터치 계약(2026-09-20, SPEC_GUIDE §6-4):
  //  1) 닿는 즉시 설명 표시  2) 짧게 탭=버튼 실행  3) 길게 누름(TOUCH_HOLD_MS 이상)=실행 없이 설명만
  //  4) 손을 뗀 뒤 TOUCH_LINGER_MS 지나면 숨김  5) 다른 곳 터치·스크롤·버튼이 가려짐(창 열림)이면 즉시 숨김
  //  길게 누른 "뒤 이동"해야 시작되는 드래그 정렬(TouchBackend 400ms)과는 공존한다.
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      lastTouchRef.current = Date.now();
      const t = e.touches[0];
      touchStartRef.current = t
        ? { at: Date.now(), x: t.clientX, y: t.clientY }
        : null;
      suppressClickRef.current = false;
      if (touchHideRef.current) {
        clearTimeout(touchHideRef.current);
        touchHideRef.current = null;
      }
      placementRef.current = 'top';
      showTooltip();
      setPinned(true);
    },
    [showTooltip],
  );

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const start = touchStartRef.current;
    const t = e.touches[0];
    if (!start || !t) return;
    // 이동하면 스크롤·드래그다 — 길게 누름으로 치지 않는다(어차피 click 도 오지 않는다).
    if (Math.hypot(t.clientX - start.x, t.clientY - start.y) > TOUCH_SLOP_PX)
      touchStartRef.current = null;
  }, []);

  const handleTouchEnd = useCallback(() => {
    lastTouchRef.current = Date.now();
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (start && Date.now() - start.at >= TOUCH_HOLD_MS) {
      // 길게 누름: 곧 올 click 한 번만 삼킨다. click 이 안 오는 경우를 대비해 곧 해제.
      suppressClickRef.current = true;
      if (suppressResetRef.current) clearTimeout(suppressResetRef.current);
      suppressResetRef.current = setTimeout(() => {
        suppressClickRef.current = false;
      }, 500);
    }
    if (touchHideRef.current) clearTimeout(touchHideRef.current);
    touchHideRef.current = setTimeout(() => {
      touchHideRef.current = null;
      setVisible(false);
      setPinned(false);
    }, TOUCH_LINGER_MS);
  }, []);

  const handleClickCapture = useCallback((e: React.MouseEvent) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // 길게 누르는 동안 WebView 가 합성하는 contextmenu 가 조상(씬 카드 메뉴 등)으로 올라가
  // "설명만 표시"를 깨지 않게 막는다. 자식 자신의 핸들러는 먼저 실행되므로 영향 없다.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (touchStartRef.current === null && !isSyntheticMouse()) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  useEffect(() => {
    if (!pinned || !visible) return undefined;
    const checkCovered = () => {
      const el = triggerRef.current;
      const child = (el?.firstElementChild as HTMLElement | null) ?? el;
      if (!el || !child || typeof document.elementFromPoint !== 'function')
        return;
      const rect = child.getBoundingClientRect();
      const top = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      if ((rect.width === 0 && rect.height === 0) || !top || !el.contains(top))
        hide();
    };
    // Dismiss when the real layout changes; a dialog may open after any amount
    // of asynchronous work, so checking at guessed elapsed times misses it.
    const mutations = new MutationObserver(checkCovered);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(checkCovered);
    const child = triggerRef.current?.firstElementChild;
    if (child) resize?.observe(child);
    const onTouchElsewhere = (e: TouchEvent) => {
      const el = triggerRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      hide();
    };
    const onDismiss = () => hide();
    document.addEventListener('touchstart', onTouchElsewhere, {
      capture: true,
      passive: true,
    });
    document.addEventListener('scroll', onDismiss, {
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', onDismiss);
    document.addEventListener('transitionend', checkCovered, true);
    document.addEventListener('animationend', checkCovered, true);
    checkCovered();
    return () => {
      mutations.disconnect();
      resize?.disconnect();
      document.removeEventListener('touchstart', onTouchElsewhere, true);
      document.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
      document.removeEventListener('transitionend', checkCovered, true);
      document.removeEventListener('animationend', checkCovered, true);
    };
  }, [pinned, visible, hide]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (touchHideRef.current) clearTimeout(touchHideRef.current);
      if (suppressResetRef.current) clearTimeout(suppressResetRef.current);
    };
  }, []);

  // 토글 버튼(접기↔펼치기 등)은 클릭 시 버튼이 이동하는데, 마우스가 안 움직여
  // mouseleave 가 안 떠 툴팁이 옛 위치에 남는다. 게다가 그런 버튼은 보통 mousedown/click
  // 전파를 막아(스플리터 리사이즈 방지) 부모 span 의 hide 도 못 받는다. content 가 바뀌면
  // (라벨이 토글되면) 강제로 숨겨 잔상을 없앤다 — 다음 hover 때 새 위치에서 다시 뜬다.
  useEffect(() => {
    hide();
  }, [content, hide]);

  if (!content) return children;

  return (
    <span
      role="presentation"
      ref={triggerRef}
      onFocus={() => {
        placementRef.current = placement;
        showTooltip();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hide();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') hide();
      }}
      onMouseEnter={show}
      onMouseLeave={hideFromMouse}
      onMouseDown={hideFromMouse}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onClickCapture={handleClickCapture}
      onContextMenu={handleContextMenu}
      className="contents"
    >
      {withTooltipAriaLabel(children, content)}
      {visible && triggerRect && (
        <TooltipPortal
          content={content}
          triggerRect={triggerRect}
          placement={activePlacement}
        />
      )}
    </span>
  );
}

export default Tooltip;
