import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { app } from 'electron';
import { DriveAuthError } from '../../shared/googleDriveAuth';
import {
  type GoogleDesktopClient,
  parseGoogleDesktopClient,
  serializeGoogleDesktopClient,
} from './clientConfig';

// Desktop OAuth identifies the application; it is not a user's authorization.
// Keep it outside project data/exports, separately from encrypted account tokens.
const CLIENT_CONFIG_FILE = 'google-drive-client.json';
const MAX_CLIENT_CONFIG_BYTES = 64 * 1024;

function configPath(): string {
  return path.join(app.getPath('userData'), CLIENT_CONFIG_FILE);
}

export async function readGoogleClientConfig(
  file: string,
): Promise<GoogleDesktopClient> {
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CLIENT_CONFIG_BYTES) {
      throw new DriveAuthError('invalid-client-config');
    }
    // Bound the actual read as well as stat: a file can grow after stat resolves.
    const bytes = new Uint8Array(MAX_CLIENT_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const chunk = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_CLIENT_CONFIG_BYTES) {
      throw new DriveAuthError('invalid-client-config');
    }
    return parseGoogleDesktopClient(
      new TextDecoder().decode(bytes.subarray(0, bytesRead)),
    );
  } finally {
    await handle.close();
  }
}

export async function loadGoogleClientConfig(): Promise<GoogleDesktopClient | null> {
  try {
    return await readGoogleClientConfig(configPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof DriveAuthError) throw error;
    throw new DriveAuthError('client-config-read-failed');
  }
}

export async function saveGoogleClientConfig(
  client: GoogleDesktopClient,
): Promise<void> {
  const target = configPath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, serializeGoogleDesktopClient(client), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporary, target);
  } catch {
    throw new DriveAuthError('client-config-save-failed');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}
