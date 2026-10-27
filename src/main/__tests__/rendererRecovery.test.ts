/** @jest-environment node */
import { EventEmitter } from 'events';
import type { BrowserWindow } from 'electron';
import { attachRendererRecovery } from '../rendererRecovery';

function fixture() {
  const contents = Object.assign(new EventEmitter(), { reload: jest.fn() });
  const win = {
    webContents: contents,
    isDestroyed: jest.fn(() => false),
    close: jest.fn(),
  };
  let choose!: (result: { response: number }) => void;
  const prompt = jest.fn(
    () =>
      new Promise<{ response: number }>((resolve) => {
        choose = resolve;
      }),
  );
  const releaseWatches = jest.fn(async () => {});
  const report = jest.fn();
  const recovery = attachRendererRecovery(win as unknown as BrowserWindow, {
    prompt,
    releaseWatches,
    report,
  });
  return {
    win,
    contents,
    prompt,
    releaseWatches,
    report,
    recovery,
    choose: (response: number) => choose({ response }),
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

describe('native renderer process recovery', () => {
  it('releases leases on a full main-frame reload while preserving same-document and subframe navigation', async () => {
    const f = fixture();
    f.contents.emit(
      'did-start-navigation',
      {},
      'file:///index.html#scene',
      true,
      true,
    );
    f.contents.emit(
      'did-start-navigation',
      {},
      'file:///child.html',
      false,
      false,
    );
    await flush();
    expect(f.releaseWatches).not.toHaveBeenCalled();
    f.contents.emit(
      'did-start-navigation',
      {},
      'file:///index.html',
      false,
      true,
    );
    await flush();
    expect(f.releaseWatches).toHaveBeenCalledTimes(1);
    expect(f.prompt).not.toHaveBeenCalled();
    expect(f.recovery.canSave()).toBe(true);
  });

  it('releases watches, shows an explicit choice and reloads only after that choice', async () => {
    const f = fixture();
    f.contents.emit(
      'render-process-gone',
      {},
      { reason: 'oom', exitCode: 134 },
    );
    await flush();
    expect(f.recovery.canSave()).toBe(false);
    expect(f.releaseWatches).toHaveBeenCalledTimes(1);
    expect(f.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        buttons: ['화면 다시 열기', '창 닫기'],
        detail: expect.stringContaining('oom'),
      }),
    );
    expect(f.contents.reload).not.toHaveBeenCalled();
    f.choose(0);
    await flush();
    expect(f.contents.reload).toHaveBeenCalledTimes(1);
    expect(f.recovery.canSave()).toBe(false);
    f.contents.emit('did-finish-load');
    expect(f.recovery.canSave()).toBe(true);
  });

  it('can close a crashed window without waiting for its impossible save acknowledgement', async () => {
    const f = fixture();
    f.contents.emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 },
    );
    await flush();
    f.choose(1);
    await flush();
    expect(f.win.close).toHaveBeenCalledTimes(1);
    expect(f.contents.reload).not.toHaveBeenCalled();
    expect(f.recovery.canSave()).toBe(false);
  });

  it('does not revive a window closed while its native prompt was pending', async () => {
    const f = fixture();
    f.contents.emit(
      'render-process-gone',
      {},
      { reason: 'crashed', exitCode: 1 },
    );
    await flush();
    f.win.isDestroyed.mockReturnValue(true);
    f.choose(0);
    await flush();
    expect(f.contents.reload).not.toHaveBeenCalled();
    expect(f.win.close).not.toHaveBeenCalled();
  });
});
