import fs from 'fs';
import path from 'path';
import React, { act, useEffect, useRef, useState } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import { observer } from 'mobx-react-lite';
import {
  STORAGE_MARKER_FILE,
  PROJECT_META_FILE,
  PROJECT_JSON_FILE,
} from '../../models/storageLayout';
import {
  WORKSPACE_ROOT,
  PROJECT_JSON_ROOT,
  PROJECT_IMAGE_ROOTS,
  workspacePath,
} from '../../models/projectPaths';
import { isOutputImageFile } from '../../models/imageFormats';
import loadComponentFixture from '../testSupport/componentFixture';

const componentFile = path.resolve(__dirname, '../StorageDiagnostics.tsx');
const modelFile = path.resolve(__dirname, '../../models/storageDiagnostics.ts');
const permissionFile = path.resolve(
  __dirname,
  '../../models/storagePermissionGate.ts',
);
const storageConstants = {
  STORAGE_MARKER_FILE,
  PROJECT_META_FILE,
  PROJECT_JSON_FILE,
  WORKSPACE_ROOT,
  PROJECT_JSON_ROOT,
  PROJECT_IMAGE_ROOTS,
  workspacePath,
  isOutputImageFile,
};
const collectStorageDiagnostics = fs.existsSync(modelFile)
  ? loadComponentFixture(
      modelFile,
      'collectStorageDiagnostics',
      storageConstants,
    )
  : undefined;

function deferred<T>() {
  let complete!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

function fixture(
  options: {
    permissionStatus?: () => Promise<{ required: boolean; granted: boolean }>;
    existFile?: (filename: string) => Promise<boolean>;
    listFiles?: (filename: string) => Promise<string[]>;
    readFile?: (filename: string) => Promise<string>;
    getFreeSpace?: () => Promise<number | null>;
  } = {},
) {
  const permissionStatus = jest.fn(
    options.permissionStatus ??
      (async () => ({ required: true, granted: true })),
  );
  const existFile = jest.fn(options.existFile ?? (async () => true));
  const listFiles = jest.fn(options.listFiles ?? (async () => []));
  const readFile = jest.fn(
    options.readFile ?? (async () => '{"name":"orphan"}'),
  );
  const getFreeSpace = jest.fn(
    options.getFreeSpace ?? (async () => 1024 * 1024 * 1024),
  );
  const pushMessage = jest.fn();
  const openSettings = jest.fn(async () => false);
  const Section = loadComponentFixture(
    componentFile,
    'StorageDiagnosticsSection',
    {
      ...storageConstants,
      observer,
      useState,
      useEffect,
      useRef,
      AbortController,
      collectStorageDiagnostics,
      isMobile: true,
      isWorkspaceLayout: () => true,
      statusIcon: (status: string) =>
        status === 'ok' ? '✅' : status === 'info' ? 'ℹ️' : '⚠️',
      backend: { existFile, listFiles, readFile, getFreeSpace },
      sessionService: {
        list: () => [],
        repairBrokenWorkspaceFolder: jest.fn(),
        get: jest.fn(),
      },
      templateService: { filterVisibleProjects: (names: string[]) => names },
      appState: { pushMessage, pushDialog: jest.fn() },
      openStoragePermissionSettings: openSettings,
      require(id: string) {
        if (id === 'react/jsx-runtime') return jsxRuntime;
        if (id === '../backends/zipService')
          return { default: { storagePermissionStatus: permissionStatus } };
        throw new Error(`Unexpected diagnostics fixture dependency: ${id}`);
      },
    },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Section />));
  return {
    container,
    existFile,
    listFiles,
    getFreeSpace,
    permissionStatus,
    pushMessage,
    openSettings,
    run: async () => {
      await act(async () => {
        (container.querySelector('button') as HTMLButtonElement).click();
      });
    },
    dispose: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

test.each(['permission', 'project list', 'config', 'free space'])(
  '%s failure is visible and cannot produce a green normal verdict',
  async (operation) => {
    const failure = new Error(`fixture ${operation} access denied`);
    const fail = async () => {
      throw failure;
    };
    const f = fixture({
      ...(operation === 'permission' ? { permissionStatus: fail } : {}),
      ...(operation === 'project list' ? { listFiles: fail } : {}),
      ...(operation === 'config'
        ? {
            existFile: async (filename: string) => {
              if (filename === 'config.json') throw failure;
              return true;
            },
          }
        : {}),
      ...(operation === 'free space' ? { getFreeSpace: fail } : {}),
    });
    try {
      await f.run();
      expect(f.container.textContent).toContain(failure.message);
      expect(f.container.textContent).toContain('진단을 완료하지 못했습니다');
      expect(f.container.textContent).not.toContain('✅ 이상 없음');
    } finally {
      f.dispose();
    }
  },
);

test('failed metadata access is unknown rather than evidence of FUSE-hidden files', async () => {
  const f = fixture({
    listFiles: async (filename) =>
      filename === WORKSPACE_ROOT ? ['orphan'] : [],
    existFile: async (filename) => {
      if (filename.endsWith('/meta.json')) throw new Error('metadata EACCES');
      return true;
    },
  });
  try {
    await f.run();
    expect(f.container.textContent).toContain('metadata EACCES');
    expect(f.container.textContent).not.toContain('파일 숨김 의심');
    expect(f.container.textContent).not.toContain('✅ 이상 없음');
    expect(
      [...f.container.querySelectorAll('button')].some(
        (button) => button.textContent === '복원',
      ),
    ).toBe(false);
  } finally {
    f.dispose();
  }
});

test('a failed project existence check is never counted as an empty healthy workspace', async () => {
  const f = fixture({
    listFiles: async (filename) =>
      filename === WORKSPACE_ROOT ? ['orphan'] : [],
    existFile: async (filename) => {
      if (filename.endsWith('/project.json')) throw new Error('project EIO');
      return true;
    },
  });
  try {
    await f.run();
    expect(f.container.textContent).toContain('project EIO');
    expect(f.container.textContent).toContain('확인 실패 1개');
    expect(f.container.textContent).not.toContain('✅ 이상 없음');
  } finally {
    f.dispose();
  }
});

test('dotted scene folder names keep their recoverable output images', async () => {
  const f = fixture({
    existFile: async (filename) =>
      [
        STORAGE_MARKER_FILE,
        'config.json',
        'workspace/orphan/meta.json',
        'workspace/orphan/outs',
      ].includes(filename),
    readFile: async (filename) => {
      if (filename === 'workspace/orphan/meta.json') return '{"name":"orphan"}';
      throw new Error('File does not exist');
    },
    listFiles: async (filename) => {
      if (filename === WORKSPACE_ROOT) return ['orphan'];
      if (filename === 'workspace/orphan/outs') return ['scene.v1'];
      if (filename === 'workspace/orphan/outs/scene.v1') return ['saved.webp'];
      return [];
    },
  });
  try {
    await f.run();
    expect(
      [...f.container.querySelectorAll('button')].some(
        (button) => button.textContent === '부분 복구',
      ),
    ).toBe(true);
    expect(f.container.textContent).toContain('이미지 있음');
  } finally {
    f.dispose();
  }
});

test('a valid backup remains recoverable when readable project metadata is malformed', async () => {
  const f = fixture({
    existFile: async (filename) =>
      [
        STORAGE_MARKER_FILE,
        'config.json',
        'workspace/orphan/meta.json',
        'workspace/orphan/project.json.bak',
      ].includes(filename),
    listFiles: async (filename) =>
      filename === WORKSPACE_ROOT ? ['orphan'] : [],
    readFile: async (filename) =>
      filename.endsWith('.bak')
        ? '{"name":"retained project"}'
        : 'malformed metadata',
  });
  try {
    await f.run();
    expect(
      [...f.container.querySelectorAll('button')].some(
        (button) => button.textContent === '복원',
      ),
    ).toBe(true);
    expect(f.container.textContent).toContain('백업본 있음');
  } finally {
    f.dispose();
  }
});

test('closing diagnostics stops further probes when an outstanding directory read completes', async () => {
  const pending = deferred<string[]>();
  const f = fixture({ listFiles: () => pending.promise });
  await f.run();
  expect(f.listFiles).toHaveBeenCalledWith(WORKSPACE_ROOT);
  f.dispose();
  await act(async () => {
    pending.resolve([]);
    await pending.promise;
  });
  expect(f.existFile).not.toHaveBeenCalledWith('config.json');
  expect(f.getFreeSpace).not.toHaveBeenCalled();
});

test('unavailable space information is shown instead of silently disappearing from diagnostics', async () => {
  const f = fixture({ getFreeSpace: async () => null });
  try {
    await f.run();
    expect(f.container.textContent).toContain(
      '여유 공간 정보를 확인할 수 없습니다',
    );
    expect(f.container.textContent).not.toContain('✅ 이상 없음');
  } finally {
    f.dispose();
  }
});

test('permission-settings launch failure is reported to the user', async () => {
  const f = fixture({
    permissionStatus: async () => ({ required: true, granted: false }),
  });
  try {
    await f.run();
    const button = [...f.container.querySelectorAll('button')].find(
      (element) => element.textContent === '모든 파일 접근 설정 열기',
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(f.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('설정 화면을 열지 못했습니다'),
      'error',
    );
  } finally {
    f.dispose();
  }
});

test.each([true, false])(
  'settings helper returns the actual launch outcome %s to its caller',
  async (opened) => {
    const openSettings = loadComponentFixture(
      permissionFile,
      'openStoragePermissionSettings',
      {
        console: { error: jest.fn() },
        require(id: string) {
          if (id !== '../backends/zipService')
            throw new Error(`Unexpected settings dependency: ${id}`);
          return {
            default: {
              openAllFilesSettings: async () => {
                if (!opened) throw new Error('settings unavailable');
              },
            },
          };
        },
      },
    ) as unknown as () => Promise<boolean>;
    await expect(openSettings()).resolves.toBe(opened);
  },
);
