import path from 'path';
import React, {
  act,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { imageService } from '../../models';
import ImagePreview from '../ImagePreview';
import PreviewReadScope from '../PreviewReadScope';
import loadComponentFixture from '../testSupport/componentFixture';

jest.mock('../../models', () => ({
  imageService: Object.assign(new EventTarget(), {
    fetchImage: jest.fn(),
    fetchImageSmall: jest.fn(),
    refresh: jest.fn(async () => {}),
    refreshBatch: jest.fn(async () => {}),
    getOutputDir: () => 'outs/project/scene',
  }),
}));

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const observers: VisibilityObserver[] = [];
class VisibilityObserver {
  readonly elements = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }

  observe = (element: Element) => this.elements.add(element);

  unobserve = (element: Element) => this.elements.delete(element);

  disconnect = () => this.elements.clear();

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

describe('image review trash preview resources', () => {
  const originalObserver = globalThis.IntersectionObserver;
  const fetchImage = imageService.fetchImage as jest.Mock;
  const fetchImageSmall = imageService.fetchImageSmall as jest.Mock;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const scene = { name: 'scene', type: 'scene' };
  const session = { name: 'project' };
  const icon = () => <span />;

  async function renderReview(count: number, isMobile = false) {
    const entries = Array.from({ length: count }, (_, i) => ({
      filename: `deleted-${i}.png`,
      deletedAt: i + 1,
    }));
    const appState = {
      samples: 1,
      pushMessage: jest.fn(),
      confirmAsync: jest.fn(async () => true),
    };
    const trashService = {
      getTrashImages: jest.fn(async () => entries),
      getTrashImagePath: (
        _session: unknown,
        _scene: unknown,
        filename: string,
      ) => `trash/${filename}`,
      restoreImages: jest.fn(
        async (_session: unknown, _scene: unknown, _filenames: string[]) => 0,
      ),
      permanentlyDeleteImages: jest.fn(
        async (_session: unknown, _scene: unknown, _filenames: string[]) => 0,
      ),
    };
    const Component = loadComponentFixture<Record<string, unknown>>(
      path.resolve(__dirname, '../ImageReview.tsx'),
      'ImageReview',
      {
        React,
        useCallback,
        useEffect,
        useLayoutEffect,
        useMemo,
        useRef,
        useState,
        createPortal,
        ImagePreview,
        PreviewReadScope,
        imageService,
        trashService,
        appState,
        isMobile,
        window,
        document,
        console,
        collectReviewItems: () => [
          {
            scene,
            filename: 'current.png',
            path: 'outs/project/scene/current.png',
          },
        ],
        backStackService: { push: () => ({ remove: jest.fn() }) },
        Tooltip: ({ children }: { children: React.ReactNode }) => children,
        FaArrowLeft: icon,
        FaArrowRight: icon,
        FaPaintBrush: icon,
        FaPlay: icon,
        FaTrash: icon,
        FaTrashRestore: icon,
        FaTimes: icon,
        trashNoticeText: () => 'Trash notice',
        IMAGE_RETENTION_DAYS: 3,
        deleteConfirmText: () => ({ text: 'Delete image permanently?' }),
      },
    );
    await act(async () =>
      root.render(
        <Component
          session={session}
          type="scene"
          onClose={jest.fn()}
          onInpaint={jest.fn(async () => {})}
        />,
      ),
    );
    return { entries, appState, trashService };
  }

  const buttons = (label: string) =>
    Array.from(document.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === label,
    );
  const previews = () =>
    Array.from(document.querySelectorAll('[data-image-preview]'));
  const show = async (elements: Element[], visible = true) => {
    await act(async () =>
      observers.forEach((observer) => observer.emit(elements, visible)),
    );
  };
  const openTrash = async () => {
    await act(async () => buttons('휴지통')[0].click());
  };
  const closeTrash = async () => {
    await act(async () =>
      (
        document.querySelector('button[aria-label="닫기"]') as HTMLButtonElement
      ).click(),
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

  test.each([
    { platform: 'desktop', isMobile: false, size: 400 },
    { platform: 'mobile', isMobile: true, size: 200 },
  ])(
    'does no offscreen trash IO and uses $size previews on $platform',
    async ({ isMobile, size }) => {
      await renderReview(60, isMobile);
      await openTrash();
      expect(fetchImageSmall).not.toHaveBeenCalled();
      expect(buttons('복원')).toHaveLength(60);
      const visible = previews().slice(0, 2);
      await show(visible);
      expect(fetchImageSmall.mock.calls).toEqual([
        ['trash/deleted-0.png', size],
        ['trash/deleted-1.png', size],
      ]);
      expect(
        document.querySelectorAll('[data-image-preview] img'),
      ).toHaveLength(2);
      await show(visible, false);
      expect(
        document.querySelectorAll('[data-image-preview] img'),
      ).toHaveLength(0);
      await closeTrash();
      expect(previews()).toHaveLength(0);
      expect(fetchImageSmall).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    {
      action: '복원',
      method: 'restoreImages' as const,
      expectedMessages: [['deleted-0.png 복원 완료']],
      expectedConfirmCalls: 0,
    },
    {
      action: '영구 삭제',
      method: 'permanentlyDeleteImages' as const,
      expectedMessages: [],
      expectedConfirmCalls: 1,
    },
  ])(
    'drains admitted reads before $action and pauses preview IO until it finishes',
    async ({ action, method, expectedMessages, expectedConfirmCalls }) => {
      const fixture = await renderReview(2);
      await openTrash();
      await closeTrash();
      const first = deferred<string>();
      const second = deferred<string>();
      const mutation = deferred<number>();
      fetchImageSmall
        .mockReset()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise)
        .mockResolvedValue('data:image/png;base64,RESUMED');
      const operation = fixture.trashService[method];
      operation.mockReturnValueOnce(mutation.promise);
      // Reopening retains the previous metadata rows. In the old implementation,
      // its eager thumbnail reload races a click on those still-present rows.
      await openTrash();
      const nodes = previews();
      await show(nodes);
      expect(fetchImageSmall).toHaveBeenCalledTimes(2);
      await act(async () => buttons(action)[0].click());
      expect(operation).not.toHaveBeenCalled();
      expect(buttons('복원').every((button) => button.disabled)).toBe(true);
      expect(buttons('영구 삭제').every((button) => button.disabled)).toBe(
        true,
      );
      await show(nodes, false);
      await act(async () => {
        first.resolve('data:image/png;base64,FIRST');
        await first.promise;
      });
      expect(operation).not.toHaveBeenCalled();
      await act(async () => {
        second.resolve('data:image/png;base64,SECOND');
        await second.promise;
      });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledWith(session, scene, ['deleted-0.png']);
      await act(async () => {
        imageService.dispatchEvent(
          new CustomEvent('image-cache-invalidated', {
            detail: { path: 'trash/deleted-1.png' },
          }),
        );
      });
      expect(fetchImageSmall).toHaveBeenCalledTimes(2);
      fixture.trashService.getTrashImages.mockResolvedValue([
        fixture.entries[1],
      ]);
      await act(async () => {
        mutation.resolve(0);
        await mutation.promise;
      });
      expect(buttons('복원')).toHaveLength(1);
      expect(buttons('복원')[0].disabled).toBe(false);
      expect(fixture.appState.pushMessage.mock.calls).toEqual(expectedMessages);
      expect(fixture.appState.confirmAsync).toHaveBeenCalledTimes(
        expectedConfirmCalls,
      );
    },
  );
});
