/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolvePreloadPath } from '../preloadPath';

describe('Electron production preload resolution', () => {
  it('loads the existing production preload when launched with the development Electron shell', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdstudio-preload-'));
    try {
      const directory = path.join(root, 'release', 'app', 'dist', 'main');
      fs.mkdirSync(directory, { recursive: true });
      const productionPreload = path.join(directory, 'preload.js');
      fs.writeFileSync(productionPreload, '// isolated fixture');
      expect(resolvePreloadPath(directory, false)).toBe(productionPreload);
      expect(fs.existsSync(resolvePreloadPath(directory, false))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains the development DLL path when no production preload exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdstudio-preload-'));
    try {
      expect(resolvePreloadPath(root, false)).toBe(
        path.resolve(root, '../../.erb/dll/preload.js'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
