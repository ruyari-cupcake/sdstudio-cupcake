/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { deferred } from '../../models/testSupport/completionMethodHarness';

const mockAppState = {
  storageBootFailure: 'saved config read denied' as string | null,
  configLoadFailure: null,
  saveLocationFallback: null,
  saveLocationFallbackAcked: false,
};
const mockBackend = {
  restartApp: jest.fn<Promise<void>, []>(),
  backupFailedConfig: jest.fn(),
  setConfig: jest.fn(),
};
jest.mock('../../models/AppService', () => ({ appState: mockAppState }));
jest.mock('../../models', () => ({ backend: mockBackend }));
jest.mock('../MigrationGate', () => ({
  GateShell: ({ children }: { children: React.ReactNode }) => {
    const react = jest.requireActual<typeof import('react')>('react');
    return react.createElement('div', { role: 'dialog' }, children);
  },
}));

const SaveLocationGate = jest.requireActual<
  typeof import('../SaveLocationGate')
>('../SaveLocationGate').default;

const previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});
beforeEach(() => {
  mockAppState.storageBootFailure = 'saved config read denied';
  mockBackend.restartApp.mockReset();
  mockBackend.backupFailedConfig.mockReset();
  mockBackend.setConfig.mockReset();
});

test('the storage boot failure has a visible restart retry, remains blocked during restart and permits another retry after rejection', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const restart = deferred<void>();
  mockBackend.restartApp.mockReturnValueOnce(restart.promise);
  const report = jest
    .spyOn(console, 'error')
    .mockImplementation(() => undefined);
  try {
    act(() => root.render(<SaveLocationGate />));
    expect(host.textContent).toContain('저장소를 준비할 수 없습니다');
    expect(host.textContent).toContain('saved config read denied');
    expect(host.textContent).not.toContain('설정 파일 백업 후 초기화');
    expect(host.textContent).not.toContain('기본 위치로 계속');
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe('앱 다시 시작하여 재시도');
    act(() => button.click());
    expect(mockBackend.restartApp).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('다시 시작하는 중…');
    act(() => button.click());
    expect(mockBackend.restartApp).toHaveBeenCalledTimes(1);
    await act(async () => {
      restart.reject(new Error('restart temporarily failed'));
      await Promise.resolve();
    });
    expect(host.textContent).toContain('앱을 다시 시작하지 못했습니다');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('앱 다시 시작하여 재시도');
    mockBackend.restartApp.mockResolvedValueOnce(undefined);
    await act(async () => button.click());
    expect(mockBackend.restartApp).toHaveBeenCalledTimes(2);
    expect(mockBackend.backupFailedConfig).not.toHaveBeenCalled();
    expect(mockBackend.setConfig).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
    report.mockRestore();
  }
});

test('a legitimate first run has no storage error overlay', () => {
  mockAppState.storageBootFailure = null;
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(<SaveLocationGate />));
    expect(host.textContent).toBe('');
    expect(host.querySelector('button')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
