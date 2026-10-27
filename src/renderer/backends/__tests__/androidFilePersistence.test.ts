/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadServiceMethods } from '../../models/testSupport/completionMethodHarness';

const previous = '{"prompts":["retained"],"revision":3}';
const replacement = '{"prompts":["saved"],"revision":4}';

describe('Android file replacement ownership', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdstudio-android-write-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function fixture(backupFailure?: Error, replaceFailure?: Error) {
    const destination = path.join(root, 'session.json');
    let sequence = 0;
    // The native owner replaces without deleting the destination first.
    const rename = jest.fn(
      async ({ from, to }: { from: string; to: string }) => {
        if (to === `${destination}.bak` && backupFailure) throw backupFailure;
        if (to === destination && replaceFailure) throw replaceFailure;
        await fs.rename(from, to);
      },
    );
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../androidBackend.ts'),
      'AndroidBackend',
      ['writeFile', 'existFile'],
      {
        APP_DIR: root,
        getDirName: path.dirname,
        Directory: { Documents: 'DOCUMENTS' },
        Encoding: { UTF8: 'utf8' },
        uuidv4: () => (++sequence === 1 ? 'pending-write' : 'pending-backup'),
        ZipService: {
          atomicRename: rename,
          pathExists: async ({ path: file }: { path: string }) => {
            try {
              await fs.stat(file);
              return { exists: true };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return { exists: false };
              throw error;
            }
          },
        },
        Filesystem: {
          mkdir: async ({ path: directory }: { path: string }) =>
            fs.mkdir(directory, { recursive: true }),
          writeFile: async ({
            path: file,
            data,
          }: {
            path: string;
            data: string;
          }) => fs.writeFile(file, data, 'utf8'),
          copy: async ({ from, to }: { from: string; to: string }) =>
            fs.copyFile(from, to),
        },
      },
    );
    return { subject: new Subject(), destination, rename };
  }

  test('a failed backup rename rejects before replacing the saved file', async () => {
    const failure = new Error('Unable to rename, unknown reason');
    const f = fixture(failure);
    await fs.writeFile(f.destination, previous);
    await expect(f.subject.writeFile('session.json', replacement)).rejects.toBe(
      failure,
    );
    expect(await fs.readFile(f.destination, 'utf8')).toBe(previous);
    expect(f.rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(root, 'pending-write'), 'utf8')).toBe(
      replacement,
    );
  });

  test('a missing source permits the first save', async () => {
    const f = fixture();
    await f.subject.writeFile('session.json', replacement);
    expect(await fs.readFile(f.destination, 'utf8')).toBe(replacement);
    await expect(fs.stat(`${f.destination}.bak`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(f.rename).toHaveBeenCalledTimes(1);
  });

  test('a failed final replacement retains the previous bytes in the live file and backup', async () => {
    const failure = new Error('Unable to perform action: I/O error');
    const f = fixture(undefined, failure);
    await fs.writeFile(f.destination, previous);
    await expect(f.subject.writeFile('session.json', replacement)).rejects.toBe(
      failure,
    );
    expect(await fs.readFile(`${f.destination}.bak`, 'utf8')).toBe(previous);
    expect(await fs.readFile(path.join(root, 'pending-write'), 'utf8')).toBe(
      replacement,
    );
    expect(await fs.readFile(f.destination, 'utf8')).toBe(previous);
    expect(f.rename).toHaveBeenCalledTimes(2);
  });
});
