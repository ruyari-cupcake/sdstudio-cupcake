import React, { createContext, useId } from 'react';
import type { GenerationEffort } from '../backends/imageGen';

/** One config read per preset editor supplies the effective mode to all controls. */
export const NaiEffortContext = createContext<GenerationEffort>('high');

export function NaiEffortControl({
  value,
  onChange,
}: {
  value: GenerationEffort;
  onChange: (value: GenerationEffort) => void;
}) {
  const controlId = useId();
  return (
    <div>
      <label htmlFor={controlId} className="block">
        <span className="text-sm gray-label mb-1 block">V5 Full effort</span>
        <select
          id={controlId}
          className="w-full back-gray border rounded px-2 py-1.5 text-sm"
          value={value}
          onChange={(event) => onChange(event.target.value as GenerationEffort)}
        >
          <option value="high">High · 기존 V5 Full</option>
          <option value="medium">Medium · 사용량 절약</option>
        </select>
      </label>
      {value === 'medium' && (
        <p className="text-xs text-faint mt-1">
          Medium은 14스텝, Euler Ancestral, 고정 Heavy UC를 사용합니다. CFG
          리스케일과 사용자·캐릭터 네거티브는 적용하지 않습니다. High에서 쓰던
          설정은 보관되며 다시 선택하면 그대로 돌아옵니다.
        </p>
      )}
    </div>
  );
}
