interface ImportFilePathBridge {
  getPathForFile?: (file: File) => string | undefined;
}

/** Native paths are resolved by preload; browsers and synthetic files have no path. */
export function getImportFilePath(
  file: File,
  bridge: ImportFilePathBridge | undefined = typeof window === 'undefined'
    ? undefined
    : window.electron,
): string | undefined {
  try {
    const value = bridge?.getPathForFile?.(file);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
