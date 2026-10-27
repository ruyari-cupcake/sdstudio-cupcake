/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditableSliderValue } from '../EditableSliderValue';

let host: HTMLDivElement;
let root: Root;
const previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function enter(value: string, commit = true) {
  act(() =>
    host.querySelector<HTMLElement>('[title="클릭하여 직접 입력"]')!.click(),
  );
  const input = host.querySelector('input')!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: commit ? 'Enter' : 'Escape',
        bubbles: true,
      }),
    ),
  );
}

test.each([-0.35, 3.75, 0.12345])(
  'reference numeric input preserves finite value %s without a visual slider clamp',
  (value) => {
    const onChange = jest.fn();
    act(() =>
      root.render(<EditableSliderValue value={0.6} onChange={onChange} />),
    );
    enter(String(value));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(value);
  },
);

test.each(['-', '', 'Infinity', 'NaN'])(
  'invalid incomplete input %s keeps the saved value',
  (value) => {
    const onChange = jest.fn();
    act(() =>
      root.render(<EditableSliderValue value={0.6} onChange={onChange} />),
    );
    enter(value);
    expect(onChange).not.toHaveBeenCalled();
  },
);

test('Vibe retains its explicit 0 to 1 domain bounds', () => {
  const onChange = jest.fn();
  act(() =>
    root.render(
      <EditableSliderValue value={0.6} min={0} max={1} onChange={onChange} />,
    ),
  );
  enter('2.5');
  expect(onChange).toHaveBeenCalledWith(1);
});

test('Escape cancels numeric editing without committing', () => {
  const onChange = jest.fn();
  act(() =>
    root.render(<EditableSliderValue value={0.6} onChange={onChange} />),
  );
  enter('-0.5', false);
  expect(onChange).not.toHaveBeenCalled();
});
