import { useLayoutEffect, useRef } from 'react';

/** Share the latest committed value without replacing long-lived event subscriptions. */
export default function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
