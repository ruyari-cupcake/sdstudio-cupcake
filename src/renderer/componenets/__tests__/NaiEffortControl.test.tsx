/** @jest-environment jsdom */
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NaiEffortControl } from '../NaiEffortControl';
import type { GenerationEffort } from '../../backends/imageGen';

const previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

test('effort control switches both ways and explains Medium constraints without removing High', () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selected = jest.fn();
  function Harness() {
    const [effort, setEffort] = useState<GenerationEffort>('high');
    return (
      <NaiEffortControl
        value={effort}
        onChange={(value) => {
          selected(value);
          setEffort(value);
        }}
      />
    );
  }
  try {
    act(() => root.render(<Harness />));
    const select = host.querySelector('select')!;
    expect(select.value).toBe('high');
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      'high',
      'medium',
    ]);
    act(() => {
      select.value = 'medium';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(selected).toHaveBeenLastCalledWith('medium');
    expect(select.value).toBe('medium');
    expect(host.textContent).toContain('14스텝');
    expect(host.textContent).toContain('고정 Heavy UC');
    expect(host.textContent).toContain('보관');
    act(() => {
      select.value = 'high';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(selected).toHaveBeenLastCalledWith('high');
    expect(host.textContent).not.toContain('14스텝');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
