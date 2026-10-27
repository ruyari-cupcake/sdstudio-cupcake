/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { NaiEffortControl } from '../NaiEffortControl';

test('each effort selector owns its accessible label when two editors are rendered', () => {
  const previous = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <>
          <NaiEffortControl value="high" onChange={() => {}} />
          <NaiEffortControl value="medium" onChange={() => {}} />
        </>,
      ),
    );
    const selects = Array.from(host.querySelectorAll('select'));
    expect(selects).toHaveLength(2);
    expect(new Set(selects.map((select) => select.id)).size).toBe(2);
    for (const select of selects) {
      expect(select.labels).toHaveLength(1);
      expect(select.labels![0].control).toBe(select);
      expect(select.labels![0].textContent).toContain('V5 Full effort');
    }
  } finally {
    act(() => root.unmount());
    host.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
