/** @jest-environment node */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { Config } from '../../../main/config';
import { ModelVersion } from '../imageGen';
import { isV5ModelVersion } from '../genVendors/naiModelCapabilities';
import {
  deferred,
  flushMicrotasks,
  loadServiceMethods,
} from '../../models/testSupport/completionMethodHarness';

const previous: Config = { modelVersion: ModelVersion.V4_5, uiFont: 'system' };
const candidate: Config = {
  modelVersion: ModelVersion.V5,
  uiFont: 'pretendard',
};
const legacyCsv = 'legacy_tag,0,1,\n';
const v5Csv = 'v5_tag,0,1,\n';

describe('Android configuration commit ownership', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sdstudio-config-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function fixture(initialConfig: Config = previous, loadFailed = false) {
    const destination = path.join(root, 'config.json');
    const fault: {
      write?: Error;
      replace?: Error;
      read?: Error;
      inspect?: Error;
      gate?: ReturnType<typeof deferred<void>>;
    } = {};
    let temporary = 0;
    let nativeCsv = legacyCsv;
    const readFile = jest.fn(async ({ path: file }: { path: string }) => {
      if (fault.read) throw fault.read;
      return { data: await fs.readFile(file, 'utf8') };
    });
    const rename = jest.fn(
      async ({ from, to }: { from: string; to: string }) => {
        // Match Capacitor 6: check source, delete destination, then rename.
        try {
          await fs.stat(from);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('The source object does not exist');
          }
          throw error;
        }
        if (to === destination && fault.gate) await fault.gate.promise;
        await fs.rm(to, { force: true });
        if (to === destination && fault.replace) throw fault.replace;
        await fs.rename(from, to);
      },
    );
    const pathExists = jest.fn(async ({ path: file }: { path: string }) => {
      if (fault.inspect) throw fault.inspect;
      try {
        await fs.stat(file);
        return { exists: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { exists: false };
        throw error;
      }
    });
    const invalidateConfigCache = jest.fn();
    const Subject = loadServiceMethods(
      path.resolve(__dirname, '../androidBackend.ts'),
      'AndroidBackend',
      [
        'getConfig',
        'setConfig',
        'reloadConfigIfFailed',
        'readFile',
        'writeFile',
        'existFile',
        'isNotFoundError',
        'loadTagDatabase',
        'applyTagDatabase',
        'tagDatabaseKindForModel',
      ],
      {
        config: { ...initialConfig },
        configLoaded: true,
        configLoadFailed: loadFailed,
        configLoadPromise: Promise.resolve(),
        configSavePromise: Promise.resolve(),
        APP_DIR: root,
        getDirName: path.dirname,
        Directory: { Documents: 'DOCUMENTS' },
        Encoding: { UTF8: 'utf8' },
        uuidv4: () => `pending-${++temporary}`,
        ModelVersion,
        isV5ModelVersion,
        DBCSV: legacyCsv,
        V5DBCSV: v5Csv,
        TagDB: {
          loadDB: async ({ path: csv }: { path: string }) => {
            nativeCsv = csv;
          },
        },
        ZipService: {
          pathExists,
          atomicRename: async ({ from, to }: { from: string; to: string }) => {
            if (to === destination && fault.gate) await fault.gate.promise;
            if (to === destination && fault.replace) throw fault.replace;
            await fs.rename(from, to);
          },
        },
        Filesystem: {
          mkdir: async ({ path: directory }: { path: string }) =>
            fs.mkdir(directory, { recursive: true }),
          readFile,
          copy: async ({ from, to }: { from: string; to: string }) =>
            fs.copyFile(from, to),
          writeFile: async ({
            path: file,
            data,
          }: {
            path: string;
            data: string;
          }) => {
            if (fault.write) throw fault.write;
            await fs.writeFile(file, data, 'utf8');
          },
          rename,
        },
      },
    );
    const subject = new Subject();
    subject.imageGenService = { invalidateConfigCache };
    subject.tagDatabaseLoadPromise = Promise.resolve();
    subject.activeTagDatabase = 'legacy';
    subject.tagDBId = 1;
    subject.tagMap = new Map();
    return {
      subject,
      destination,
      fault,
      invalidateConfigCache,
      readFile,
      pathExists,
      nativeCsv: () => nativeCsv,
    };
  }

  test('editing a returned config cannot change effective settings when its save fails', async () => {
    const saved: Config = {
      ...previous,
      downloadSettings: { defaultPrefix: 'retained' },
    };
    const savedJson = JSON.stringify(saved);
    const f = fixture(saved);
    await fs.writeFile(f.destination, savedJson);
    const edited = await f.subject.getConfig();
    edited.uiFont = 'pretendard';
    edited.downloadSettings.defaultPrefix = 'unsaved';
    f.fault.write = new Error('write denied');
    await expect(f.subject.setConfig(edited)).rejects.toBe(f.fault.write);
    expect(await f.subject.getConfig()).toEqual(JSON.parse(savedJson));
    expect(await fs.readFile(f.destination, 'utf8')).toBe(savedJson);
  });

  test('pending replacement does not publish the proposed configuration', async () => {
    const f = fixture();
    await fs.writeFile(f.destination, JSON.stringify(previous));
    f.fault.gate = deferred<void>();
    const saving = f.subject.setConfig(candidate);
    await flushMicrotasks();
    try {
      expect(await f.subject.getConfig()).toEqual(previous);
      expect(f.invalidateConfigCache).not.toHaveBeenCalled();
    } finally {
      f.fault.gate.resolve();
      await saving;
    }
    expect(await f.subject.getConfig()).toEqual(candidate);
    expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
      candidate,
    );
  });

  test('failed file write preserves effective config and tag model, then a retry succeeds', async () => {
    const f = fixture();
    await fs.writeFile(f.destination, JSON.stringify(previous));
    const failure = new Error('storage denied');
    f.fault.write = failure;
    await expect(f.subject.setConfig(candidate)).rejects.toBe(failure);
    expect(await f.subject.getConfig()).toEqual(previous);
    expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
      previous,
    );
    expect(f.nativeCsv()).toBe(legacyCsv);
    expect(f.invalidateConfigCache).not.toHaveBeenCalled();
    delete f.fault.write;
    await f.subject.setConfig(candidate);
    expect(await f.subject.getConfig()).toEqual(candidate);
    expect(f.nativeCsv()).toBe(v5Csv);
    expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
      candidate,
    );
  });

  test('a queued save cannot overtake a pending one and owns its caller snapshot', async () => {
    const f = fixture();
    await fs.writeFile(f.destination, JSON.stringify(previous));
    f.fault.gate = deferred<void>();
    const first = f.subject.setConfig(candidate);
    const next: Config = {
      ...previous,
      downloadSettings: { defaultPrefix: 'queued' },
    };
    const nextSnapshot = JSON.parse(JSON.stringify(next));
    const second = f.subject.setConfig(next);
    next.downloadSettings!.defaultPrefix = 'later mutation';
    await flushMicrotasks();
    try {
      expect(await f.subject.getConfig()).toEqual(previous);
      expect(f.invalidateConfigCache).not.toHaveBeenCalled();
    } finally {
      f.fault.gate.resolve();
      await Promise.all([first, second]);
    }
    expect(await f.subject.getConfig()).toEqual(nextSnapshot);
    expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
      nextSnapshot,
    );
    expect(f.nativeCsv()).toBe(legacyCsv);
  });

  test('a failed final replacement retains the primary and backup across restart', async () => {
    const f = fixture();
    await fs.writeFile(f.destination, JSON.stringify(previous));
    const failure = new Error('rename denied');
    f.fault.replace = failure;
    await expect(f.subject.setConfig(candidate)).rejects.toBe(failure);
    expect(await f.subject.getConfig()).toEqual(previous);
    expect(f.nativeCsv()).toBe(legacyCsv);
    expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
      previous,
    );
    const restarted = fixture({}, true);
    await restarted.subject.reloadConfigIfFailed();
    expect(await restarted.subject.getConfig()).toEqual(previous);
    expect(
      JSON.parse(await fs.readFile(`${f.destination}.bak`, 'utf8')),
    ).toEqual(previous);
  });

  test.each(['read', 'inspect'] as const)(
    'a failed %s prevents reload and later overwriting of unknown settings',
    async (boundary) => {
      const f = fixture({}, true);
      await fs.writeFile(f.destination, JSON.stringify(previous));
      const failure = Object.assign(new Error('storage unavailable'), {
        code: 'EACCES',
      });
      f.fault[boundary] = failure;
      await expect(f.subject.reloadConfigIfFailed()).rejects.toBe(failure);
      await expect(f.subject.setConfig(candidate)).rejects.toBe(failure);
      expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
        previous,
      );
      expect(await f.subject.getConfig()).toEqual({});
      expect(f.invalidateConfigCache).not.toHaveBeenCalled();
    },
  );

  test('invalid JSON remains a failed reload and does not permit overwriting', async () => {
    const f = fixture({}, true);
    await fs.writeFile(f.destination, '{"truncated":');
    await expect(f.subject.reloadConfigIfFailed()).rejects.toMatchObject({
      name: 'SyntaxError',
    });
    await expect(f.subject.setConfig(candidate)).rejects.toMatchObject({
      name: 'SyntaxError',
    });
    expect(await fs.readFile(f.destination, 'utf8')).toBe('{"truncated":');
  });

  test('a missing primary reloads its retained legacy backup before accepting a new save', async () => {
    const f = fixture({}, true);
    await fs.writeFile(`${f.destination}.bak`, JSON.stringify(previous));
    await f.subject.reloadConfigIfFailed();
    expect(await f.subject.getConfig()).toEqual(previous);
    expect(f.nativeCsv()).toBe(legacyCsv);
    await f.subject.setConfig(candidate);
    expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
      candidate,
    );
    expect(
      JSON.parse(await fs.readFile(`${f.destination}.bak`, 'utf8')),
    ).toEqual(previous);
  });

  test('confirmed absence of both config and backup preserves first-run setup', async () => {
    const f = fixture({}, true);
    await expect(f.subject.reloadConfigIfFailed()).resolves.toBeUndefined();
    expect(await f.subject.getConfig()).toEqual({});
    await f.subject.setConfig(candidate);
    expect(JSON.parse(await fs.readFile(f.destination, 'utf8'))).toEqual(
      candidate,
    );
    expect(await f.subject.getConfig()).toEqual(candidate);
  });
});
