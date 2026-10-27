/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadServiceMethods } from '../../models/testSupport/completionMethodHarness';

describe('Android atomic file publication', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdstudio-atomic-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function fixture(failedTarget?: string) {
    const failure = new Error('injected replacement failure');
    let sequence = 0;
    const atomicRename = jest.fn(
      async ({ from, to }: { from: string; to: string }) => {
        if (to === failedTarget) throw failure;
        await fs.rename(from, to);
      },
    );
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../androidBackend.ts'),
      'AndroidBackend',
      ['writeFile', 'renameFile', 'existFile', 'isNotFoundError'],
      {
        APP_DIR: root,
        getDirName: path.dirname,
        Directory: { Documents: 'DOCUMENTS' },
        Encoding: { UTF8: 'utf8' },
        uuidv4: () => `pending-${++sequence}`,
        ZipService: {
          atomicRename,
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
          // The installed Capacitor 6 rename deletes an existing destination first.
          // This deliberately preserves that observable behavior, including its failure.
          rename: async ({ from, to }: { from: string; to: string }) => {
            try {
              await fs.stat(from);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                throw new Error('The source object does not exist');
              throw error;
            }
            await fs.rm(to, { force: true });
            if (to === failedTarget) throw failure;
            await fs.rename(from, to);
          },
        },
      },
    );
    return { subject: new Subject(), failure, atomicRename };
  }

  test('a rejected manifest rename retains both previous manifest and staged replacement', async () => {
    const destination = path.join(root, 'manifest.json');
    const pending = path.join(root, 'staged.json');
    await fs.writeFile(destination, 'previous manifest');
    await fs.writeFile(pending, 'replacement manifest');
    const f = fixture(destination);
    await expect(
      f.subject.renameFile('staged.json', 'manifest.json'),
    ).rejects.toBe(f.failure);
    expect(await fs.readFile(destination, 'utf8')).toBe('previous manifest');
    expect(await fs.readFile(pending, 'utf8')).toBe('replacement manifest');
  });

  test('a failed final write retains the live file as well as its backup', async () => {
    const destination = path.join(root, 'state.json');
    await fs.writeFile(destination, 'previous state');
    const f = fixture(destination);
    await expect(f.subject.writeFile('state.json', 'next state')).rejects.toBe(
      f.failure,
    );
    expect(await fs.readFile(destination, 'utf8')).toBe('previous state');
    expect(await fs.readFile(`${destination}.bak`, 'utf8')).toBe(
      'previous state',
    );
  });

  test('a failed backup publication preserves both prior live and backup values', async () => {
    const destination = path.join(root, 'state.json');
    await fs.writeFile(destination, 'previous state');
    await fs.writeFile(`${destination}.bak`, 'older backup');
    const f = fixture(`${destination}.bak`);
    await expect(f.subject.writeFile('state.json', 'next state')).rejects.toBe(
      f.failure,
    );
    expect(await fs.readFile(destination, 'utf8')).toBe('previous state');
    expect(await fs.readFile(`${destination}.bak`, 'utf8')).toBe(
      'older backup',
    );
  });

  test('successful write publishes new bytes and retains the previous saved bytes', async () => {
    const destination = path.join(root, 'state.json');
    await fs.writeFile(destination, 'previous state');
    const f = fixture();
    await f.subject.writeFile('state.json', 'next state');
    expect(await fs.readFile(destination, 'utf8')).toBe('next state');
    expect(await fs.readFile(`${destination}.bak`, 'utf8')).toBe(
      'previous state',
    );
  });

  test('first save needs no pre-existing file or backup', async () => {
    const destination = path.join(root, 'state.json');
    const f = fixture();
    await f.subject.writeFile('state.json', 'first state');
    expect(await fs.readFile(destination, 'utf8')).toBe('first state');
    await expect(fs.stat(`${destination}.bak`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
