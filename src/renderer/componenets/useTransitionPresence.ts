import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Keep a sliding panel mounted until its own CSS transition completes.
 * Completion belongs to a real Animation; elapsed time is never a readiness signal.
 */
export default function useTransitionPresence(
  open: boolean,
  property = 'transform',
) {
  const [render, setRender] = useState(open);
  const [shown, setShown] = useState(open);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setShown(false);
      return undefined;
    }
    setRender(true);
    let nextFrame = 0;
    // Paint the mounted starting pose before requesting the visible pose.
    const firstFrame = requestAnimationFrame(() => {
      nextFrame = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(nextFrame);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open || !render || shown) return undefined;
    const panel = panelRef.current;
    const transitions =
      panel
        ?.getAnimations?.()
        .filter(
          (animation) =>
            'transitionProperty' in animation &&
            animation.transitionProperty === property,
        ) ?? [];
    if (transitions.length === 0) {
      // Reduced motion, an unchanged pose, or no completion API means no owner
      // to wait for. Remove the hidden surface instead of intercepting input.
      setRender(false);
      return undefined;
    }
    let active = true;
    void Promise.allSettled(
      transitions.map((animation) => animation.finished),
    ).then(() => {
      if (active) setRender(false);
      return undefined;
    });
    return () => {
      active = false;
    };
  }, [open, property, render, shown]);

  return { render, shown, panelRef };
}
