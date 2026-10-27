import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import DriveConnectSection from '../DriveConnectSection';

const mockConfigure = jest.fn();
const mockMessage = jest.fn();
const mockDialog = jest.fn();
const mockStatus = jest.fn();
const mockConnected = jest.fn();

jest.mock('../../models', () => ({
  isMobile: false,
  backend: {
    driveAuthSupported: () => true,
    driveAuthStatus: () => mockStatus(),
    onDriveAuthChanged: () => () => {},
    driveAuthConfigure: () => mockConfigure(),
    driveAuthConnect: () => mockConnected(),
    openWebPage: jest.fn(),
  },
}));
jest.mock('../../models/AppService', () => ({
  appState: {
    pushMessage: (...args: unknown[]) => mockMessage(...args),
    pushDialog: (...args: unknown[]) => mockDialog(...args),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockStatus.mockResolvedValue({
    connected: false,
    persistent: true,
    notConfigured: true,
  });
  mockConfigure.mockResolvedValue({ connected: false, persistent: true });
  mockConnected.mockResolvedValue({
    connected: true,
    persistent: true,
    email: 'fixture@example.invalid',
  });
});

test('a client-less install offers app configuration and enables account connection only after save succeeds', async () => {
  render(<DriveConnectSection />);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Google 앱 설정 불러오기' }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole('button', { name: 'Google 계정 연결' }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Google 앱 설정 불러오기' }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Google 계정 연결' }),
    ).toBeEnabled(),
  );
  expect(mockConfigure).toHaveBeenCalledTimes(1);
  expect(mockMessage).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Google 계정 연결' }));
  await screen.findByText('fixture@example.invalid');
  expect(
    screen.queryByRole('button', { name: 'Google 앱 설정 불러오기' }),
  ).not.toBeInTheDocument();
});

test('cancelling the native picker keeps the unavailable status and does not report a save', async () => {
  mockConfigure.mockResolvedValue(null);
  render(<DriveConnectSection />);
  const button = screen.getByRole('button', {
    name: 'Google 앱 설정 불러오기',
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
  expect(
    screen.getByRole('button', { name: 'Google 계정 연결' }),
  ).toBeDisabled();
  expect(mockMessage).not.toHaveBeenCalled();
});

test('a rejected save leaves connecting disabled and presents its error', async () => {
  mockConfigure.mockRejectedValue(new Error('설정 저장 실패'));
  render(<DriveConnectSection />);
  const button = screen.getByRole('button', {
    name: 'Google 앱 설정 불러오기',
  });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() =>
    expect(mockDialog).toHaveBeenCalledWith({
      type: 'yes-only',
      text: '설정 저장 실패',
    }),
  );
  expect(
    screen.getByRole('button', { name: 'Google 계정 연결' }),
  ).toBeDisabled();
  expect(mockMessage).not.toHaveBeenCalled();
});
