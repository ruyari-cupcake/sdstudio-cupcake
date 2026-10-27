export interface StorageLocationChangeState {
  path: string;
  phase: 'saving' | 'restarting';
  error?: string;
}

export interface StorageLocationChangeDependencies {
  assertIdle(): void;
  flush(): Promise<void>;
  commit(path: string): Promise<void>;
  restart(): Promise<void>;
  setState(state: StorageLocationChangeState | null): void;
}

/** Keep the old data root for the entire running process. Flush before changing
 * the persisted location, then hold the UI closed until a real restart. */
export async function changeStorageLocation(
  path: string,
  dependencies: StorageLocationChangeDependencies,
): Promise<void> {
  dependencies.assertIdle();
  dependencies.setState({ path, phase: 'saving' });
  let committed = false;
  try {
    await dependencies.flush();
    // A queued operation can become active while storage was draining.
    dependencies.assertIdle();
    await dependencies.commit(path);
    committed = true;
    dependencies.setState({ path, phase: 'restarting' });
    await dependencies.restart();
  } catch (error) {
    dependencies.setState(
      committed
        ? {
            path,
            phase: 'restarting',
            error: error instanceof Error ? error.message : String(error),
          }
        : null,
    );
    throw error;
  }
}
