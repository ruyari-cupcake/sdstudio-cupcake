import fs from 'fs';
import path from 'path';

/** A built app also runs under an unpackaged Electron shell during verification. */
export function resolvePreloadPath(
  directory: string,
  isPackaged: boolean,
): string {
  const production = path.join(directory, 'preload.js');
  if (isPackaged || fs.existsSync(production)) return production;
  return path.resolve(directory, '../../.erb/dll/preload.js');
}
