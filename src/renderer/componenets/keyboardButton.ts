import type { KeyboardEvent } from 'react';

/** Give non-native action surfaces the same Enter/Space access as their click action. */
export default function activateButtonFromKeyboard(
  event: KeyboardEvent<HTMLElement>,
): void {
  if (
    event.target !== event.currentTarget ||
    event.defaultPrevented ||
    event.repeat ||
    event.currentTarget.getAttribute('aria-disabled') === 'true' ||
    (event.key !== 'Enter' && event.key !== ' ')
  )
    return;
  event.preventDefault();
  event.currentTarget.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    }),
  );
}
