import React, { useEffect, useRef, useState } from 'react';

/** Numeric editing may be unbounded even when the companion slider has a range. */
export function EditableSliderValue({
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const editingRef = useRef(false);

  const startEditing = () => {
    if (disabled) return;
    editingRef.current = true;
    setInputValue(String(value));
    setEditing(true);
  };
  const finishEditing = (commit: boolean) => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    if (!commit || !inputValue.trim()) return;
    const parsed = Number(inputValue);
    if (!Number.isFinite(parsed)) return;
    // Only real caller-supplied domain bounds clamp the value. References do
    // not inherit their slider's visual range or an arbitrary precision limit.
    const bounded = Math.min(
      max ?? Infinity,
      Math.max(min ?? -Infinity, parsed),
    );
    onChange(bounded);
  };
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        data-esc-cancel
        inputMode="decimal"
        className="w-14 flex-none text-sm text-center border border-sky-400 rounded bg-[var(--c-input-bg)] text-default outline-none px-0.5 py-0.5"
        value={inputValue}
        onChange={(event) => setInputValue(event.target.value)}
        onBlur={() => finishEditing(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finishEditing(true);
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finishEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      className="w-11 flex-none text-lg text-center back-lllgray cursor-pointer hover:ring-2 hover:ring-sky-400 rounded transition-all"
      onClick={startEditing}
      title="클릭하여 직접 입력"
    >
      {value}
    </button>
  );
}
