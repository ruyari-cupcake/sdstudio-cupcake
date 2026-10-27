import type { AppUpdateNoticeService } from './AppUpdateNoticeService';

export interface AppUpdateInstallDependencies {
  assertIdle(): void;
  flush(): Promise<void>;
  install(): Promise<void>;
  cancel(): Promise<void>;
  mobile: boolean;
}

/** Hold interaction closed while saving, then ask the native installer to close
 * the app through its normal save/close acknowledgement. Native failures may
 * arrive after install() acknowledges, through onInstallError. */
export async function installApplicationUpdate(
  service: AppUpdateNoticeService,
  dependencies: AppUpdateInstallDependencies,
): Promise<void> {
  if (service.phase === 'installing') return;
  try {
    dependencies.assertIdle();
    service.beginInstall();
    await dependencies.flush();
    // Work can have been admitted before the interaction gate became visible.
    dependencies.assertIdle();
    await dependencies.install();
    if (dependencies.mobile) service.finishAndroidInstall();
  } catch (error) {
    let failure = error;
    try {
      await dependencies.cancel();
    } catch (cancelError) {
      const message = (value: unknown) =>
        value instanceof Error ? value.message : String(value);
      failure = new Error(`${message(error)}\n${message(cancelError)}`);
    }
    service.failInstall(failure);
  }
}
