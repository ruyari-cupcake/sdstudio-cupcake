/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

let mockProfile = '';
const mockDialog = jest.fn();
const mockLoadRecord = jest.fn(async (_clientId: string) => null);
const mockSaveRecord = jest.fn(async () => true);
const mockDeleteRecord = jest.fn(async () => {});
const mockLoopback = jest.fn();
const mockPost = jest.fn();
const mockRequest = jest.fn();

jest.mock('electron', () => ({
  app: { getPath: () => mockProfile },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: (...args: unknown[]) => mockDialog(...args) },
  shell: { openExternal: jest.fn() },
}));
jest.mock('electron-log', () => ({ warn: jest.fn(), info: jest.fn() }));
jest.mock('../googleDrive/store', () => ({
  loadAuthRecord: (id: string) => mockLoadRecord(id),
  saveAuthRecord: () => mockSaveRecord(),
  deleteAuthFile: () => mockDeleteRecord(),
  isPersistentStorageAvailable: () => true,
}));
jest.mock('../googleDrive/auth', () => ({
  startLoopbackAuthorization: (...args: unknown[]) => mockLoopback(...args),
}));
jest.mock('../googleDrive/http', () => ({
  postForm: (...args: unknown[]) => mockPost(...args),
  httpRequest: (...args: unknown[]) => mockRequest(...args),
}));

const clientId = 'fixture.apps.googleusercontent.com';
const clientSecret = 'fixture-client-value';
const installed = {
  installed: {
    client_id: clientId,
    client_secret: clientSecret,
    // Downloaded metadata cannot redirect authorization or token transport.
    auth_uri: 'https://unexpected.invalid/auth',
    token_uri: 'https://unexpected.invalid/token',
    redirect_uris: ['https://unexpected.invalid/callback'],
    refresh_token: 'ignored-token',
  },
};
const savedEnv = {
  id: process.env.SDSTUDIO_GOOGLE_CLIENT_ID,
  secret: process.env.SDSTUDIO_GOOGLE_CLIENT_SECRET,
};

function freshDrive(): typeof import('../googleDrive') {
  let drive: typeof import('../googleDrive');
  jest.isolateModules(() => {
    drive = jest.requireActual('../googleDrive');
  });
  return drive!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockProfile = fs.mkdtempSync(
    path.join(os.tmpdir(), 'sdstudio-google-client-'),
  );
  delete process.env.SDSTUDIO_GOOGLE_CLIENT_ID;
  delete process.env.SDSTUDIO_GOOGLE_CLIENT_SECRET;
  mockDialog.mockResolvedValue({ canceled: true, filePaths: [] });
  mockLoopback.mockResolvedValue({
    code: Promise.resolve('fixture-authorization-code'),
    verifier: 'fixture-verifier',
    redirectUri: 'http://127.0.0.1:32100/callback',
    cancel: jest.fn(),
  });
  mockPost.mockResolvedValue({
    status: 200,
    body: {
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      expires_in: 3600,
    },
  });
  mockRequest.mockResolvedValue({
    status: 200,
    body: { user: { emailAddress: 'fixture@example.invalid' } },
  });
});

afterEach(() => fs.rmSync(mockProfile, { recursive: true, force: true }));
afterAll(() => {
  for (const [key, value] of Object.entries({
    SDSTUDIO_GOOGLE_CLIENT_ID: savedEnv.id,
    SDSTUDIO_GOOGLE_CLIENT_SECRET: savedEnv.secret,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a build with no bundled client loads its saved desktop app configuration before checking availability', async () => {
  fs.writeFileSync(
    path.join(mockProfile, 'google-drive-client.json'),
    JSON.stringify(installed),
  );
  const drive = freshDrive();
  const status = await drive.getStatus();
  expect(status.notConfigured).toBeUndefined();
  expect(status.connected).toBe(false);
  expect(mockLoadRecord).toHaveBeenCalledWith(clientId);
  expect(JSON.stringify(status)).not.toContain(clientId);
  expect(JSON.stringify(status)).not.toContain(clientSecret);
});

test('saved app settings use the fixed Google endpoints and actual loopback redirect for a real connect owner', async () => {
  fs.writeFileSync(
    path.join(mockProfile, 'google-drive-client.json'),
    JSON.stringify(installed),
  );
  const drive = freshDrive();
  const status = await drive.connect();
  expect(status.connected).toBe(true);
  expect(mockLoopback).toHaveBeenCalledWith(
    expect.objectContaining({
      authEndpoint: 'https://accounts.google.com/o/oauth2/auth',
      clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
    }),
  );
  expect(mockPost).toHaveBeenCalledWith(
    'https://oauth2.googleapis.com/token',
    expect.objectContaining({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: 'http://127.0.0.1:32100/callback',
    }),
  );
  expect(JSON.stringify(mockPost.mock.calls)).not.toContain(
    'unexpected.invalid',
  );
  expect(JSON.stringify(mockPost.mock.calls)).not.toContain('ignored-token');
});

test('the native picker saves only desktop client fields and immediately enables connecting', async () => {
  const selected = path.join(mockProfile, 'download.json');
  fs.writeFileSync(selected, JSON.stringify(installed));
  mockDialog.mockResolvedValue({ canceled: false, filePaths: [selected] });
  const drive = freshDrive();
  expect((await drive.getStatus()).notConfigured).toBe(true);
  const result = await drive.configureClientForIpc();
  expect(result).toMatchObject({ ok: true, status: { connected: false } });
  if (!result.ok || !result.status)
    throw new Error('Expected committed client');
  expect(result.status.notConfigured).toBeUndefined();
  const stored = JSON.parse(
    fs.readFileSync(path.join(mockProfile, 'google-drive-client.json'), 'utf8'),
  );
  expect(stored).toEqual({
    installed: { client_id: clientId, client_secret: clientSecret },
  });
  expect(JSON.stringify(result)).not.toContain(clientSecret);
  expect(JSON.stringify(result)).not.toContain(clientId);
  const reopened = freshDrive();
  expect((await reopened.getStatus()).notConfigured).toBeUndefined();
  expect((await reopened.connect()).connected).toBe(true);
  expect(mockPost).toHaveBeenCalledWith(
    'https://oauth2.googleapis.com/token',
    expect.objectContaining({ client_id: clientId }),
  );
});

test('picker cancellation and invalid web credentials preserve the previously saved client', async () => {
  const target = path.join(mockProfile, 'google-drive-client.json');
  const original = JSON.stringify(installed);
  fs.writeFileSync(target, original);
  const drive = freshDrive();
  await expect(drive.configureClientForIpc()).resolves.toEqual({
    ok: true,
    status: null,
  });
  const selected = path.join(mockProfile, 'web-client.json');
  fs.writeFileSync(selected, JSON.stringify({ web: installed.installed }));
  mockDialog.mockResolvedValue({ canceled: false, filePaths: [selected] });
  await expect(drive.configureClientForIpc()).resolves.toEqual({
    ok: false,
    code: 'invalid-client-config',
  });
  expect(fs.readFileSync(target, 'utf8')).toBe(original);
  expect(mockDeleteRecord).not.toHaveBeenCalled();
});

test('a failed atomic replacement does not publish new credentials in memory or on disk', async () => {
  const target = path.join(mockProfile, 'google-drive-client.json');
  const original = JSON.stringify(installed);
  fs.writeFileSync(target, original);
  const selected = path.join(mockProfile, 'replacement.json');
  fs.writeFileSync(
    selected,
    JSON.stringify({
      installed: {
        client_id: 'replacement.apps.googleusercontent.com',
        client_secret: 'replacement-value',
      },
    }),
  );
  mockDialog.mockResolvedValue({ canceled: false, filePaths: [selected] });
  const drive = freshDrive();
  const rename = jest
    .spyOn(fs.promises, 'rename')
    .mockRejectedValueOnce(new Error('simulated disk failure'));
  try {
    await expect(drive.configureClientForIpc()).resolves.toEqual({
      ok: false,
      code: 'client-config-save-failed',
    });
  } finally {
    rename.mockRestore();
  }
  expect(fs.readFileSync(target, 'utf8')).toBe(original);
  expect(
    fs.readdirSync(mockProfile).filter((name) => name.endsWith('.tmp')),
  ).toEqual([]);
  await drive.connect();
  expect(mockPost).toHaveBeenCalledWith(
    'https://oauth2.googleapis.com/token',
    expect.objectContaining({ client_id: clientId }),
  );
});

test('configuration is exclusive across windows and cannot replace an active connection', async () => {
  fs.writeFileSync(
    path.join(mockProfile, 'google-drive-client.json'),
    JSON.stringify(installed),
  );
  let finishPicker!: (value: {
    canceled: boolean;
    filePaths: string[];
  }) => void;
  let pickerOpened!: () => void;
  const opened = new Promise<void>((resolve) => {
    pickerOpened = resolve;
  });
  mockDialog.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishPicker = resolve;
        pickerOpened();
      }),
  );
  const drive = freshDrive();
  const pending = drive.configureClientForIpc();
  await opened;
  await expect(drive.configureClientForIpc()).resolves.toEqual({
    ok: false,
    code: 'busy',
  });
  await expect(drive.connect()).rejects.toMatchObject({ code: 'busy' });
  finishPicker({ canceled: true, filePaths: [] });
  await pending;
  await drive.connect();
  await expect(drive.configureClientForIpc()).resolves.toEqual({
    ok: false,
    code: 'already-connected',
  });
  expect(mockDialog).toHaveBeenCalledTimes(1);
});
