export interface ExternalImageEditor {
  watchImage(path: string): Promise<void>;
  unwatchImage(path: string): Promise<void>;
  openImageEditor(path: string): Promise<void>;
}

export type ImageWatchLeases = Map<string, Promise<void>>;

/** Acquire metadata before opening an editor; repeated clicks share one subscription. */
export async function openWatchedImage(
  leases: ImageWatchLeases,
  path: string,
  backend: ExternalImageEditor,
): Promise<void> {
  let acquired = leases.get(path);
  if (!acquired) {
    acquired = backend.watchImage(path);
    leases.set(path, acquired);
  }
  try {
    await acquired;
  } catch (error) {
    if (leases.get(path) === acquired) leases.delete(path);
    throw error;
  }
  // A view can unmount while the initial metadata read is pending.
  if (leases.get(path) === acquired) await backend.openImageEditor(path);
}

export async function releaseImageWatches(
  leases: ImageWatchLeases,
  backend: ExternalImageEditor,
): Promise<void> {
  const owned = Array.from(leases.entries());
  leases.clear();
  await Promise.all(
    owned.map(async ([path, acquired]) => {
      try {
        await acquired;
        await backend.unwatchImage(path);
      } catch (error) {
        console.error('Release image watch:', error);
      }
    }),
  );
}
