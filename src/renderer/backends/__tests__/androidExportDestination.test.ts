/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { loadServiceMethods } from '../../models/testSupport/completionMethodHarness';

type NativePath = { path: string; directory: string };

describe('Android export destination ownership', () => {
  let root: string;
  const documents = 'DOCUMENTS';
  const external = 'EXTERNAL';
  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'sdstudio-export-destination-'),
    );
    await fs.mkdir(path.join(root, documents, '.SDStudio', 'exports'), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, external, 'Download'), { recursive: true });
    await fs.writeFile(
      path.join(root, documents, '.SDStudio', 'exports', 'archive.tar'),
      'new export',
    );
    await fs.writeFile(
      path.join(root, external, 'Download', 'archive.tar'),
      'existing download',
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function fixture(probeFailure?: Error) {
    const resolve = (input: NativePath) =>
      path.join(root, input.directory, input.path);
    const copy = jest.fn(
      async (input: {
        from: string;
        directory: string;
        to: string;
        toDirectory: string;
      }) => {
        await fs.copyFile(
          resolve({ path: input.from, directory: input.directory }),
          resolve({ path: input.to, directory: input.toDirectory }),
        );
      },
    );
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../androidBackend.ts'),
      'AndroidBackend',
      ['saveExportToDownloads', 'publishExport', 'isNotFoundError'],
      {
        APP_DIR: '.SDStudio',
        Directory: { Documents: documents, ExternalStorage: external },
        require: (moduleName: string) => {
          if (moduleName !== '../models/AppService')
            throw new Error('Unexpected UI module');
          return {
            appState: {
              pushDialog: (dialog: { onCancel: () => void }) =>
                dialog.onCancel(),
              pushMessage: jest.fn(),
            },
          };
        },
        Filesystem: {
          mkdir: async (input: NativePath) => fs.mkdir(resolve(input)),
          stat: async (input: NativePath) => {
            if (
              probeFailure &&
              input.directory === external &&
              input.path === 'Download/archive.tar'
            )
              throw probeFailure;
            const stat = await fs.stat(resolve(input));
            return {
              type: stat.isDirectory() ? 'directory' : 'file',
              size: stat.size,
            };
          },
          copy,
          deleteFile: async (input: NativePath) => fs.unlink(resolve(input)),
          getUri: async (input: NativePath) => ({
            uri: `file://${resolve(input)}`,
          }),
        },
      },
    );
    return { subject: new Subject(), copy };
  }

  test.each(['saveExportToDownloads', 'publishExport'])(
    '%s refuses an unverified destination without copying or deleting data',
    async (method) => {
      const failure = Object.assign(new Error('permission denied'), {
        code: 'EACCES',
      });
      const f = fixture(failure);
      await expect(f.subject[method]('exports/archive.tar')).rejects.toBe(
        failure,
      );
      expect(f.copy).not.toHaveBeenCalled();
      expect(
        await fs.readFile(
          path.join(root, external, 'Download', 'archive.tar'),
          'utf8',
        ),
      ).toBe('existing download');
      expect(
        await fs.readFile(
          path.join(root, documents, '.SDStudio', 'exports', 'archive.tar'),
          'utf8',
        ),
      ).toBe('new export');
    },
  );

  test('a real filename collision chooses a free name and preserves the previous download', async () => {
    const f = fixture();
    await expect(
      f.subject.saveExportToDownloads('exports/archive.tar'),
    ).resolves.toBe('Download/archive (1).tar');
    expect(
      await fs.readFile(
        path.join(root, external, 'Download', 'archive.tar'),
        'utf8',
      ),
    ).toBe('existing download');
    expect(
      await fs.readFile(
        path.join(root, external, 'Download', 'archive (1).tar'),
        'utf8',
      ),
    ).toBe('new export');
    expect(f.copy).toHaveBeenCalledTimes(1);
    await expect(
      fs.stat(
        path.join(root, documents, '.SDStudio', 'exports', 'archive.tar'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
