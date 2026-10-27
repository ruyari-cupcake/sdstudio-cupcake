import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { AppUpdateNoticeService } from '../AppUpdateNoticeService';
import type {
  UpdateBackend,
  UpdateProgress,
  UpdateState,
} from '../../../shared/appUpdate';
import AppUpdateSection from '../../componenets/AppUpdateSection';

jest.mock('..', () => ({
  appUpdateNoticeService: undefined,
  backend: { openWebPage: jest.fn() },
}));

function fixture(channel: 'private' | 'public') {
  let state: UpdateState = {
    channel,
    connected: channel === 'public',
    supported: true,
    version: '6.1.0-cupcake.1',
    snoozedUntil: Date.now() + 86400000,
  };
  const api: jest.Mocked<UpdateBackend> = {
    getState: jest.fn(async () => ({ ...state })),
    claimStartupCheck: jest.fn(async () => true),
    check: jest.fn(async () => null),
    snooze: jest.fn(async () => {}),
    connect: jest.fn(async (_token: string) => {
      state = { ...state, connected: true };
    }),
    disconnect: jest.fn(async () => {
      state = { ...state, connected: false };
    }),
    download: jest.fn(async (_version: string) => {}),
    cancelDownload: jest.fn(async () => {}),
    install: jest.fn(async () => {}),
    cancelInstall: jest.fn(async () => {}),
    onProgress: jest.fn(
      (_listener: (progress: UpdateProgress) => void) => () => {},
    ),
    onInstallError: jest.fn((_listener: (message: string) => void) => () => {}),
  };
  const service = new AppUpdateNoticeService({
    getVersion: async () => state.version,
    updates: api,
  });
  return { api, service };
}

it('offers a manual public check during snooze without displaying private login controls', async () => {
  const { api, service } = fixture('public');
  render(<AppUpdateSection service={service} />);
  const check = await screen.findByRole('button', { name: '업데이트 확인' });
  expect(
    screen.queryByLabelText('GitHub 업데이트 토큰'),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/자동 알림을/)).toBeInTheDocument();
  fireEvent.click(check);
  await screen.findByText('최신 버전이에요.');
  expect(api.check).toHaveBeenCalledTimes(1);
});

it('keeps connection help inline and clears the entered token after native connection', async () => {
  const { api, service } = fixture('private');
  render(<AppUpdateSection service={service} />);
  const input = await screen.findByLabelText('GitHub 업데이트 토큰');
  expect(input).toHaveAttribute('type', 'password');
  expect(screen.queryByText(/Contents/)).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: '비공개 업데이트 연결 도움말' }),
  );
  expect(screen.getByText(/Contents/)).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: 'test-token' } });
  fireEvent.click(screen.getByRole('button', { name: '연결' }));
  await screen.findByText('비공개 업데이트 연결됨');
  expect(api.connect).toHaveBeenCalledWith('test-token');
  expect(screen.queryByDisplayValue('test-token')).not.toBeInTheDocument();
  expect(api.check).toHaveBeenCalledTimes(1);
});

it('renders a native lookup failure instead of a false latest-version message', async () => {
  const { api, service } = fixture('public');
  api.check.mockRejectedValueOnce(new Error('인터넷에 연결할 수 없어요.'));
  render(<AppUpdateSection service={service} />);
  fireEvent.click(await screen.findByRole('button', { name: '업데이트 확인' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '인터넷에 연결할 수 없어요.',
  );
  expect(screen.queryByText('최신 버전이에요.')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '업데이트 확인' })).toBeEnabled(),
  );
});
