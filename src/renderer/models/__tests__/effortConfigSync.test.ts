import {
  applyConfigGroups,
  buildConfigExport,
  diffConfigGroups,
  parseConfigImport,
} from '../configSync';
import { captureGenerationSettings } from '../../backends/generationSettings';

const meta = {
  createdAt: '2026-10-24T00:00:00Z',
  appVersion: 'fixture',
  platform: 'pc' as const,
};

test.each(['high', 'medium'] as const)(
  'config export/import roundtrip preserves %s effort',
  (effort) => {
    const exported = buildConfigExport({ effort }, meta);
    expect(exported.groups.generation.effort).toBe(effort);
    const parsed = parseConfigImport(JSON.stringify(exported));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('fixture import failed');
    const applied = applyConfigGroups({}, parsed.value.groups, {
      generation: true,
    });
    expect(applied.effort).toBe(effort);
  },
);

test('unsupported effort values are not imported as config', () => {
  const parsed = parseConfigImport({
    type: 'sdstudio-config',
    version: 1,
    groups: { generation: { effort: 'low' } },
  });
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error('fixture import failed');
  expect(parsed.value.groups.generation).not.toHaveProperty('effort');
});

test('legacy absent effort retains the local preference and explicit null resets to High', () => {
  expect(
    applyConfigGroups(
      { effort: 'medium' },
      { generation: {} },
      { generation: true },
    ).effort,
  ).toBe('medium');
  const reset = applyConfigGroups(
    { effort: 'medium' },
    { generation: { effort: null } },
    { generation: true },
  );
  expect(captureGenerationSettings(reset).effort).toBe('high');
  expect(
    diffConfigGroups({}, { generation: { effort: 'high' } })[0].changed,
  ).not.toContain('effort');
});
