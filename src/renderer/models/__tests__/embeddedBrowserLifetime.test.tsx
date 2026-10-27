/**
 * @jest-environment jsdom
 * @jest-environment-options {"userAgent":"Mozilla/5.0 TestBrowser Chrome/123.0.0.0 Electron/30.0.0 sdstudio/6.0.0 Safari/537.36"}
 */
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import DesktopBrowser from '../../componenets/EmbeddedBrowser';

jest.mock('../../componenets/ActionIcon', () => ({ ActionIcon: () => null }));
jest.mock('../BackStackService', () => ({ useBackLayer: () => {} }));
jest.mock('../../componenets/backdropClose', () => ({
  useBackdropClose: () => ({}),
}));

function fixture() {
  const view = render(<DesktopBrowser />);
  const webview = view.container.querySelector('webview') as any;
  Object.assign(webview, {
    canGoBack: jest.fn(() => true),
    canGoForward: jest.fn(() => false),
    stop: jest.fn(),
    reload: jest.fn(),
    loadURL: jest.fn(async () => {}),
    goBack: jest.fn(),
    goForward: jest.fn(),
  });
  const emit = (name: string, detail: Record<string, unknown> = {}) =>
    act(() => {
      webview.dispatchEvent(Object.assign(new Event(name), detail));
    });
  return { ...view, webview, emit };
}

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.clear();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('legitimate rapid redirects and SPA navigation are never interrupted or automatically reloaded', async () => {
  const f = fixture();
  f.emit('did-start-loading');
  for (let i = 0; i < 12; i += 1) {
    f.emit('did-navigate', { url: `https://example.test/redirect-${i}` });
  }
  f.emit('did-navigate-in-page', {
    url: 'https://example.test/final#section',
    isMainFrame: true,
  });
  f.emit('did-stop-loading');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10_000);
  });
  expect(f.webview.stop).not.toHaveBeenCalled();
  expect(f.webview.reload).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(
    'https://example.test/final#section',
  );
  expect(screen.getByRole('button', { name: '새로고침' })).toBeDefined();
});

test('an actual main-frame load failure is visible and retries its failed URL only after an explicit click', async () => {
  const f = fixture();
  f.emit('did-start-loading');
  f.emit('did-fail-load', {
    errorCode: -105,
    errorDescription: 'ERR_NAME_NOT_RESOLVED',
    validatedURL: 'https://unavailable.test/target',
    isMainFrame: true,
  });
  expect(screen.getByRole('alert').textContent).toContain(
    'ERR_NAME_NOT_RESOLVED',
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(30_000);
  });
  expect(f.webview.reload).not.toHaveBeenCalled();
  expect(f.webview.loadURL).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(f.webview.loadURL).toHaveBeenCalledTimes(1);
  expect(f.webview.loadURL).toHaveBeenCalledWith(
    'https://unavailable.test/target',
  );
  expect(screen.queryByRole('alert')).toBeNull();
});

test('ERR_ABORTED and subframe failures do not create a main-page error or automatic navigation', async () => {
  const f = fixture();
  for (let i = 0; i < 12; i += 1) {
    f.emit('did-fail-load', { errorCode: -3, isMainFrame: true });
    f.emit('did-fail-load', { errorCode: -105, isMainFrame: false });
  }
  await act(async () => {
    await jest.advanceTimersByTimeAsync(30_000);
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(f.webview.stop).not.toHaveBeenCalled();
  expect(f.webview.reload).not.toHaveBeenCalled();
  expect(f.webview.loadURL).not.toHaveBeenCalled();
});

test('bookmarks and explicit navigation still work with the clean browser user agent, and listeners are released on unmount', async () => {
  const f = fixture();
  expect(f.webview.getAttribute('useragent')).toBe(
    'Mozilla/5.0 TestBrowser Chrome/123.0.0.0 Safari/537.36',
  );
  expect(f.webview.getAttribute('useragent')).not.toMatch(/Electron\//i);
  fireEvent.click(screen.getByRole('button', { name: 'Danbooru' }));
  expect(f.webview.loadURL).toHaveBeenCalledWith('https://hijiribe.donmai.us/');
  f.unmount();
  for (let i = 0; i < 12; i += 1)
    f.emit('did-navigate', { url: `https://example.test/${i}` });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10_000);
  });
  expect(f.webview.stop).not.toHaveBeenCalled();
  expect(f.webview.reload).not.toHaveBeenCalled();
});
