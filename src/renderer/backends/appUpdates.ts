import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  UpdateBackend,
  UpdateProgress,
  UpdateRelease,
  UpdateState,
} from '../../shared/appUpdate';

export function electronUpdates(): UpdateBackend {
  const invoke = (operation: string, value?: string) =>
    window.electron.ipcRenderer.invoke('app-update', operation, value);
  return {
    getState: () => invoke('state'),
    claimStartupCheck: () => invoke('claim-startup'),
    check: () => invoke('check'),
    snooze: () => invoke('snooze'),
    connect: (token) => invoke('connect', token),
    disconnect: () => invoke('disconnect'),
    download: (version) => invoke('download', version),
    cancelDownload: () => invoke('cancel-download'),
    install: () => invoke('install'),
    cancelInstall: () => invoke('cancel-install'),
    onProgress: (callback) =>
      window.electron.ipcRenderer.on('app-update-progress', callback),
    onInstallError: (callback) =>
      window.electron.ipcRenderer.on('app-update-install-error', callback),
  };
}
interface NativeUpdates {
  state(): Promise<UpdateState>;
  claimStartup(): Promise<{ claimed: boolean }>;
  check(): Promise<{ release: UpdateRelease | null }>;
  snooze(): Promise<void>;
  connect(options: { token: string }): Promise<void>;
  disconnect(): Promise<void>;
  download(options: { version: string }): Promise<void>;
  cancelDownload(): Promise<void>;
  install(): Promise<void>;
  cancelInstall(): Promise<void>;
  addListener(
    event: 'progress',
    callback: (value: UpdateProgress) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    event: 'installError',
    callback: (value: { message: string }) => void,
  ): Promise<PluginListenerHandle>;
}
export function androidUpdates(): UpdateBackend {
  const native = registerPlugin<NativeUpdates>('AppUpdates');
  return {
    getState: () => native.state(),
    claimStartupCheck: async () => (await native.claimStartup()).claimed,
    check: async () => (await native.check()).release,
    snooze: () => native.snooze(),
    connect: (token) => native.connect({ token }),
    disconnect: () => native.disconnect(),
    download: (version) => native.download({ version }),
    cancelDownload: () => native.cancelDownload(),
    install: () => native.install(),
    cancelInstall: () => native.cancelInstall(),
    onProgress: (callback) => {
      let removed = false;
      const handle = native.addListener('progress', (progress) => {
        if (!removed) callback(progress);
      });
      return () => {
        removed = true;
        void handle.then((listener) => listener.remove());
      };
    },
    onInstallError: (callback) => {
      let removed = false;
      const handle = native.addListener('installError', ({ message }) => {
        if (!removed) callback(message);
      });
      return () => {
        removed = true;
        void handle.then((listener) => listener.remove());
      };
    },
  };
}
