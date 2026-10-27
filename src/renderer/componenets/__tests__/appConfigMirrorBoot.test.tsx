/** @jest-environment jsdom */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import React, { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import {
  deferred,
  flushMicrotasks,
} from '../../models/testSupport/completionMethodHarness';

type ConfigSnapshot = Record<string, unknown>;
type ConfigFailure = { path: string; code: string } | null;

/** Run the real hook call and dependency array, avoiding unrelated App services. */
function loadConfigMirror(bindings: Record<string, unknown>) {
  const filename = path.resolve(__dirname, '../App.tsx');
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments[0]?.getText(source).includes('const refreshDarkMode =')
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (calls.length !== 1)
    throw new Error('Expected one App config mirror effect');
  const compiled = ts.transpileModule(
    `function ConfigMirrorFixture({ bootReady, configLoadFailure }) {
      const [darkMode, setDarkMode] = useState(false);
      const [trueDark, setTrueDark] = useState(false);
      const [themeOverrides, setThemeOverrides] = useState({});
      ${calls[0].getText(source)};
      return React.createElement('output', null,
        JSON.stringify({ darkMode, trueDark, themeOverrides }));
    }`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  return vm.runInNewContext(`${compiled}\nConfigMirrorFixture;`, {
    React,
    useEffect,
    useState,
    ...bindings,
  }) as React.ComponentType<{
    bootReady: boolean;
    configLoadFailure: ConfigFailure;
  }>;
}

function mirrorFixture(initial: ConfigSnapshot = {}) {
  let saved = initial;
  const listeners = new Set<() => void | Promise<void>>();
  const pushMessage = jest.fn();
  const appState: Record<string, unknown> = {
    uiLayoutTemplate: 'before-ready',
    uiFont: 'before-ready',
    pushMessage,
  };
  const backend = {
    getConfig: jest.fn<Promise<ConfigSnapshot>, []>(async () => saved),
  };
  const sessionService = {
    addEventListener: jest.fn(
      (_event: string, listener: () => void | Promise<void>) => {
        listeners.add(listener);
      },
    ),
    removeEventListener: jest.fn(
      (_event: string, listener: () => void | Promise<void>) => {
        listeners.delete(listener);
      },
    ),
  };
  const buildThemeVars = jest.fn((theme: unknown, whiteMode: boolean) => ({
    '--fixture-theme': JSON.stringify(theme),
    '--fixture-white': String(whiteMode),
  }));
  const errors = { error: jest.fn() };
  const Mirror = loadConfigMirror({
    appState,
    backend,
    sessionService,
    buildThemeVars,
    defaultLayoutTemplateId: () => 'first-run-mobile-layout',
    isMobile: true,
    console: errors,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    appState,
    backend,
    sessionService,
    buildThemeVars,
    pushMessage,
    errors,
    saved: (next: ConfigSnapshot) => {
      saved = next;
    },
    async render(bootReady: boolean, configLoadFailure: ConfigFailure = null) {
      await act(async () => {
        root.render(
          <Mirror
            bootReady={bootReady}
            configLoadFailure={configLoadFailure}
          />,
        );
        await flushMicrotasks();
      });
    },
    async configChanged() {
      await act(async () => {
        // Observe a legacy async listener's rejection so RED is a missing user
        // notification assertion, rather than an unhandled-promise test crash.
        await Promise.allSettled(
          Array.from(listeners, (listener) => listener()),
        );
        await flushMicrotasks();
      });
    },
    view: () => JSON.parse(host.textContent || '{}'),
    dispose() {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

test('config mirroring waits for permission recovery and then uses the saved settings on the ready render', async () => {
  const f = mirrorFixture({});
  try {
    await f.render(false);
    expect(f.backend.getConfig).not.toHaveBeenCalled();
    expect(f.sessionService.addEventListener).not.toHaveBeenCalled();
    expect(f.appState.uiLayoutTemplate).toBe('before-ready');
    expect(f.appState.uiFont).toBe('before-ready');
    const theme = { accent: '#5f8fc9' };
    f.saved({
      whiteMode: true,
      trueDark: true,
      uiTheme: theme,
      uiLayoutTemplate: 'saved-mobile-layout',
      uiFont: 'pretendard',
      uiPillButtons: true,
      uiCombinationView: 'card',
    });
    await f.render(true);
    expect(f.backend.getConfig).toHaveBeenCalledTimes(1);
    expect(f.appState.uiLayoutTemplate).toBe('saved-mobile-layout');
    expect(f.appState.uiFont).toBe('pretendard');
    expect(f.appState.uiPillButtons).toBe(true);
    expect(f.appState.uiCombinationView).toBe('card');
    expect(f.buildThemeVars).toHaveBeenCalledWith(theme, true);
    expect(f.view()).toEqual({
      darkMode: false,
      trueDark: true,
      themeOverrides: {
        '--fixture-theme': JSON.stringify(theme),
        '--fixture-white': 'true',
      },
    });
  } finally {
    f.dispose();
  }
});

test('a desktop config warning cannot mirror fallback settings even when the old ready gate is open', async () => {
  const f = mirrorFixture({});
  try {
    await f.render(true, { path: '/private/config.json', code: 'EACCES' });
    expect(f.backend.getConfig).not.toHaveBeenCalled();
    expect(f.sessionService.addEventListener).not.toHaveBeenCalled();
    expect(f.appState.uiLayoutTemplate).toBe('before-ready');
  } finally {
    f.dispose();
  }
});

test('a legitimate first run still receives the existing mobile defaults', async () => {
  const f = mirrorFixture({});
  try {
    await f.render(true);
    expect(f.backend.getConfig).toHaveBeenCalledTimes(1);
    expect(f.appState.uiLayoutTemplate).toBe('first-run-mobile-layout');
    expect(f.appState.uiFont).toBe('system');
    expect(f.appState.uiCombinationView).toBe('list');
    expect(f.view()).toMatchObject({ darkMode: true, trueDark: false });
  } finally {
    f.dispose();
  }
});

test('a failed config refresh reports the error, preserves mirrored settings and accepts the next change', async () => {
  const f = mirrorFixture({ uiFont: 'pretendard', whiteMode: true });
  try {
    await f.render(true);
    const failure = new Error('config IPC failed');
    f.backend.getConfig.mockRejectedValueOnce(failure);
    await f.configChanged();
    expect(f.errors.error).toHaveBeenCalledWith(
      '화면 설정 반영 실패:',
      failure,
    );
    expect(f.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('화면 설정'),
      'error',
    );
    expect(f.appState.uiFont).toBe('pretendard');
    expect(f.view().darkMode).toBe(false);
    f.saved({ uiFont: 'system', whiteMode: false });
    await f.configChanged();
    expect(f.appState.uiFont).toBe('system');
    expect(f.view().darkMode).toBe(true);
  } finally {
    f.dispose();
  }
});

test('an in-flight config read cannot publish after the owning effect is cleaned up', async () => {
  const f = mirrorFixture();
  const pending = deferred<ConfigSnapshot>();
  f.backend.getConfig.mockReturnValueOnce(pending.promise);
  await f.render(true);
  f.dispose();
  pending.resolve({ uiFont: 'pretendard', uiLayoutTemplate: 'late-layout' });
  await flushMicrotasks();
  expect(f.appState.uiFont).toBe('before-ready');
  expect(f.appState.uiLayoutTemplate).toBe('before-ready');
  expect(f.sessionService.removeEventListener).toHaveBeenCalledWith(
    'config-changed',
    f.sessionService.addEventListener.mock.calls[0][1],
  );
});
