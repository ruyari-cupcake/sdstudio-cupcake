import path from 'path';
import React, {
  act,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { imageService } from '../../models';
import ImagePreview from '../ImagePreview';
import PreviewReadScope from '../PreviewReadScope';
import loadComponentFixture from '../testSupport/componentFixture';
import activateButtonFromKeyboard from '../keyboardButton';

jest.mock('../../models', () => ({
  imageService: Object.assign(new EventTarget(), {
    fetchImage: jest.fn(),
    fetchImageSmall: jest.fn(),
    refresh: jest.fn(async () => {}),
  }),
}));

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const icon = () => <span />;
const observers: VisibilityObserver[] = [];
class VisibilityObserver {
  readonly elements = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }

  observe = (element: Element) => this.elements.add(element);

  unobserve = (element: Element) => this.elements.delete(element);

  disconnect = jest.fn(() => this.elements.clear());

  emit(elements: Element[], visible: boolean) {
    this.callback(
      elements
        .filter((element) => this.elements.has(element))
        .map(
          (target) =>
            ({
              target,
              isIntersecting: visible,
            }) as IntersectionObserverEntry,
        ),
      this as unknown as IntersectionObserver,
    );
  }
}

describe('gallery preview resource ownership', () => {
  const originalObserver = globalThis.IntersectionObserver;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const fetchImage = imageService.fetchImage as jest.Mock;
  const fetchImageSmall = imageService.fetchImageSmall as jest.Mock;
  const commonBindings = {
    React,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    observer: (component: unknown) => component,
    imageService,
    ImagePreview,
    PreviewReadScope,
    FaImage: icon,
    FaTrash: icon,
    ActionIcon: icon,
    activateButtonFromKeyboard,
    console,
  };

  function artistComponent() {
    return loadComponentFixture<{
      path: string;
      className: string;
      previewSize?: number;
    }>(
      path.resolve(__dirname, '../ArtistLibraryTab.tsx'),
      'ArtistImage',
      commonBindings,
    );
  }

  function trashComponent(
    items: { filename: string; deletedAt: number }[],
    restoreImages = jest.fn(
      async (_session: unknown, _scene: unknown, _filenames: string[]) => 0,
    ),
  ) {
    const appState = {
      pushMessage: jest.fn(),
      pushDialog: jest.fn(),
      setProgressDialog: jest.fn(),
    };
    const trashService = {
      getTrashImages: jest.fn(async () => items),
      getTrashImagePath: (
        _session: unknown,
        _scene: unknown,
        filename: string,
      ) => `trash/${filename}`,
      restoreImages,
    };
    const Component = loadComponentFixture<Record<string, unknown>>(
      path.resolve(__dirname, '../ResultViewer.tsx'),
      'TrashImageView',
      {
        ...commonBindings,
        isMobile: false,
        trashService,
        appState,
        trashNoticeText: () => 'Trash notice',
        IMAGE_RETENTION_DAYS: 30,
      },
    );
    return { Component, appState, trashService };
  }

  const previews = () =>
    Array.from(container.querySelectorAll('[data-image-preview]'));
  const button = (text: string) =>
    Array.from(container.querySelectorAll('button')).find((element) =>
      element.textContent?.startsWith(text),
    )!;
  const show = async (elements: Element[], visible = true) => {
    await act(async () =>
      observers.forEach((observer) => observer.emit(elements, visible)),
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    observers.length = 0;
    fetchImage.mockReset().mockResolvedValue('data:image/png;base64,ORIGINAL');
    fetchImageSmall
      .mockReset()
      .mockResolvedValue('data:image/png;base64,THUMBNAIL');
    globalThis.IntersectionObserver =
      VisibilityObserver as unknown as typeof IntersectionObserver;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    expect(observers.every((observer) => observer.elements.size === 0)).toBe(
      true,
    );
    globalThis.IntersectionObserver = originalObserver;
  });

  it('does no original or thumbnail IO for thirty offscreen artist cards', async () => {
    const ArtistImage = artistComponent();
    await act(async () =>
      root.render(
        <>
          {Array.from({ length: 30 }, (_, i) => (
            <ArtistImage
              key={i}
              path={`artist-library/images/sample-${i}.png`}
              className="w-full h-full"
            />
          ))}
        </>,
      ),
    );
    expect(fetchImage).not.toHaveBeenCalled();
    expect(fetchImageSmall).not.toHaveBeenCalled();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(observers).toHaveLength(1);
    const visible = previews().slice(0, 3);
    await show(visible);
    expect(fetchImage).not.toHaveBeenCalled();
    expect(fetchImageSmall.mock.calls).toEqual([
      ['artist-library/images/sample-0.png', 400],
      ['artist-library/images/sample-1.png', 400],
      ['artist-library/images/sample-2.png', 400],
    ]);
    expect(container.querySelectorAll('img')).toHaveLength(3);
    await show(visible, false);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(fetchImageSmall).toHaveBeenCalledTimes(3);
  });

  it('does no thumbnail IO for fifty offscreen trash images while keeping all items selectable', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      filename: `deleted-${i}.png`,
      deletedAt: i,
    }));
    const { Component } = trashComponent(items);
    await act(async () =>
      root.render(
        <Component
          session={{ name: 'project' }}
          scene={{ name: 'scene' }}
          imageSize={400}
        />,
      ),
    );
    expect(fetchImageSmall).not.toHaveBeenCalled();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('[role="button"]')).toHaveLength(50);
    act(() => button('전체 선택').click());
    expect(container.textContent).toContain('선택 복원 (50)');
    await show(previews().slice(0, 2));
    expect(fetchImageSmall.mock.calls).toEqual([
      ['trash/deleted-0.png', 400],
      ['trash/deleted-1.png', 400],
    ]);
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('preserves original detail quality and uses small thumbnails for the sample strip', async () => {
    const ArtistImage = artistComponent();
    await act(async () =>
      root.render(
        <>
          <ArtistImage
            path="detail.png"
            className="w-full h-full"
            previewSize={-1}
          />
          <ArtistImage
            path="strip.png"
            className="w-full h-full"
            previewSize={200}
          />
        </>,
      ),
    );
    await show(previews());
    expect(fetchImage.mock.calls).toEqual([['detail.png']]);
    expect(fetchImageSmall.mock.calls).toEqual([['strip.png', 200]]);
    expect(
      Array.from(container.querySelectorAll('img')).map((image) =>
        image.getAttribute('src'),
      ),
    ).toEqual([
      'data:image/png;base64,ORIGINAL',
      'data:image/png;base64,THUMBNAIL',
    ]);
  });

  it('rejects obsolete selection results, reacts to batch invalidation, and releases hidden reads', async () => {
    const first = deferred<string>();
    fetchImageSmall
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue('data:image/png;base64,NEW');
    await act(async () =>
      root.render(<ImagePreview path="old.png" size={400} alt="sample" />),
    );
    await show(previews());
    await act(async () =>
      root.render(<ImagePreview path="new.png" size={400} alt="sample" />),
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,NEW',
    );
    await act(async () => {
      first.resolve('data:image/png;base64,OLD');
      await first.promise;
    });
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,NEW',
    );
    fetchImageSmall.mockResolvedValueOnce('data:image/png;base64,CHANGED');
    await act(async () => {
      imageService.dispatchEvent(
        new CustomEvent('image-cache-invalidated', {
          detail: { path: 'other.png', paths: ['other.png', 'new.png'] },
        }),
      );
    });
    expect(fetchImageSmall).toHaveBeenCalledTimes(3);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,CHANGED',
    );
    const pending = deferred<string>();
    fetchImageSmall.mockReturnValueOnce(pending.promise);
    await act(async () => {
      imageService.dispatchEvent(
        new CustomEvent('image-cache-invalidated', {
          detail: { path: 'new.png' },
        }),
      );
    });
    await show(previews(), false);
    await act(async () => {
      pending.resolve('data:image/png;base64,LATE');
      await pending.promise;
    });
    expect(container.querySelectorAll('img')).toHaveLength(0);
    await act(async () => {
      imageService.dispatchEvent(
        new CustomEvent('image-cache-invalidated', {
          detail: { path: 'new.png' },
        }),
      );
    });
    expect(fetchImageSmall).toHaveBeenCalledTimes(4);
  });

  it('waits for all admitted preview reads before restoring and admits no reads during the mutation', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const restore = deferred<number>();
    fetchImageSmall
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const restoreImages = jest.fn(
      (_session: unknown, _scene: unknown, _filenames: string[]) =>
        restore.promise,
    );
    const items = ['a.png', 'b.png', 'c.png'].map((filename) => ({
      filename,
      deletedAt: 1,
    }));
    const { Component, trashService } = trashComponent(items, restoreImages);
    await act(async () =>
      root.render(
        <Component
          session={{ name: 'project' }}
          scene={{ name: 'scene' }}
          imageSize={400}
        />,
      ),
    );
    const nodes = previews();
    await show(nodes.slice(0, 2));
    act(() => button('전체 선택').click());
    await act(async () => button('선택 복원').click());
    expect(restoreImages).not.toHaveBeenCalled();
    await show([nodes[2]]);
    expect(fetchImageSmall).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.resolve('data:image/png;base64,FIRST');
      await first.promise;
    });
    expect(restoreImages).not.toHaveBeenCalled();
    await act(async () => {
      second.resolve('data:image/png;base64,SECOND');
      await second.promise;
    });
    expect(restoreImages).toHaveBeenCalledTimes(1);
    expect(restoreImages.mock.calls[0][2]).toEqual(['a.png', 'b.png', 'c.png']);
    expect(fetchImageSmall).toHaveBeenCalledTimes(2);
    trashService.getTrashImages.mockResolvedValue([]);
    await act(async () => {
      restore.resolve(0);
      await restore.promise;
    });
    expect(container.textContent).toContain('휴지통이 비어있습니다');
  });

  it('reports failed restore at the click boundary and resumes visible previews', async () => {
    const restore = deferred<number>();
    const restoreImages = jest.fn(
      (_session: unknown, _scene: unknown, _filenames: string[]) =>
        restore.promise,
    );
    const { Component, appState } = trashComponent(
      [{ filename: 'a.png', deletedAt: 1 }],
      restoreImages,
    );
    await act(async () =>
      root.render(
        <Component
          session={{ name: 'project' }}
          scene={{ name: 'scene' }}
          imageSize={400}
        />,
      ),
    );
    await show(previews());
    act(() => button('전체 선택').click());
    await act(async () => button('선택 복원').click());
    expect(button('선택 복원').disabled).toBe(true);
    await act(async () => {
      restore.reject(new Error('disk locked'));
      await restore.promise.catch(() => {});
    });
    expect(appState.pushMessage).toHaveBeenCalledWith(
      expect.stringContaining('disk locked'),
    );
    expect(button('선택 복원').disabled).toBe(false);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,THUMBNAIL',
    );
    expect(fetchImageSmall).toHaveBeenCalledTimes(2);
  });
});

describe('preview read scope', () => {
  it('keeps overlapping pauses until all callers release and resumes after failure', async () => {
    const scope = new PreviewReadScope();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstOperation = scope.whilePaused(() => first.promise);
    const secondOperation = scope.whilePaused(() => second.promise);
    const read = jest.fn(async () => 'bytes');
    expect(await scope.read(read)).toBeNull();
    first.resolve();
    await firstOperation;
    expect(scope.isPaused).toBe(true);
    const rejected = (async () => {
      await expect(secondOperation).rejects.toThrow('failed');
    })();
    second.reject(new Error('failed'));
    await rejected;
    expect(scope.isPaused).toBe(false);
    expect(await scope.read(read)).toBe('bytes');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a read paused before its microtask and observes failed admitted reads', async () => {
    const scope = new PreviewReadScope();
    const skipped = jest.fn(async () => 'stale');
    const read = scope.read(skipped);
    const operation = jest.fn(async () => 'done');
    const mutation = scope.whilePaused(operation);
    expect(await read).toBeNull();
    expect(await mutation).toBe('done');
    expect(skipped).not.toHaveBeenCalled();
    const pending = deferred<string>();
    const failed = scope.read(() => pending.promise);
    await Promise.resolve();
    const rejection = (async () => {
      await expect(failed).rejects.toThrow('read failed');
    })();
    const nextMutation = scope.whilePaused(operation);
    pending.reject(new Error('read failed'));
    await rejection;
    expect(await nextMutation).toBe('done');
    expect(scope.isPaused).toBe(false);
  });
});
