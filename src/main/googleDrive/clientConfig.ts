import { DriveAuthError } from '../../shared/googleDriveAuth';

export interface GoogleDesktopClient {
  clientId: string;
  clientSecret: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Accept the desktop client download, never web credentials or account tokens.
 * Endpoint/redirect metadata is intentionally ignored: the authorization owner
 * always uses its fixed Google endpoints and its own loopback PKCE callback.
 */
export function parseGoogleDesktopClient(text: string): GoogleDesktopClient {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new DriveAuthError('invalid-client-config');
  }
  const installed = object(object(value)?.installed);
  const clientId = installed?.client_id;
  const clientSecret = installed?.client_secret;
  if (
    typeof clientId !== 'string' ||
    !/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId.trim()) ||
    typeof clientSecret !== 'string' ||
    !clientSecret.trim() ||
    /\s/.test(clientSecret.trim()) ||
    Array.from(clientSecret.trim()).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new DriveAuthError('invalid-client-config');
  }
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

export function serializeGoogleDesktopClient(
  client: GoogleDesktopClient,
): string {
  const serialized = JSON.stringify(
    {
      installed: {
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
    },
    null,
    2,
  );
  return `${serialized}\n`;
}
