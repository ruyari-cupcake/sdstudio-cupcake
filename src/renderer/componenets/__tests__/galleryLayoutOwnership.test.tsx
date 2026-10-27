import path from 'path';
import React, {
  act,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import loadComponentFixture from '../testSupport/componentFixture';

test('a requested gallery position waits for measured layout and uses its actual columns', () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  let notifyResize!: (
    entries: { contentRect: { width: number; height: number } }[],
  ) => void;
  class ResizeObserverDouble {
    constructor(callback: typeof notifyResize) {
      notifyResize = callback;
    }

    observe = jest.fn();

    disconnect = jest.fn();
  }
  const scrollToItem = jest.fn();
  const GridDouble = forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ scrollToItem }));
    return null;
  });
  type GalleryHandle = { scrollToIndex(index: number): void };
  const Gallery = loadComponentFixture<{
    ref: React.RefObject<GalleryHandle>;
    scene: object;
    filePaths: string[];
    imageSize: number;
    selectedImages: Set<string>;
  }>(path.resolve(__dirname, '../ResultViewer.tsx'), 'ImageGallery', {
    React,
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
    ResizeObserver: ResizeObserverDouble,
    Grid: GridDouble,
    Cell: () => null,
    CustomScrollbarsVirtualGrid: () => null,
    createItemData: () => ({}),
    appState: { curSession: {} },
    isMobile: false,
    window,
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const ref = React.createRef<GalleryHandle>();
  try {
    act(() =>
      root.render(
        <Gallery
          ref={ref}
          scene={{}}
          filePaths={Array.from({ length: 10 }, (_, i) => `${i}.png`)}
          imageSize={200}
          selectedImages={new Set()}
        />,
      ),
    );
    act(() => {
      ref.current!.scrollToIndex(8);
    });
    expect(scrollToItem).not.toHaveBeenCalled();
    act(() => {
      notifyResize([{ contentRect: { width: 400, height: 300 } }]);
    });
    expect(scrollToItem).toHaveBeenCalledTimes(1);
    expect(scrollToItem).toHaveBeenLastCalledWith({
      rowIndex: 4,
      align: 'center',
    });
    act(() => {
      notifyResize([{ contentRect: { width: 600, height: 300 } }]);
    });
    expect(scrollToItem).toHaveBeenCalledTimes(1);
    act(() => {
      ref.current!.scrollToIndex(8);
    });
    expect(scrollToItem).toHaveBeenLastCalledWith({
      rowIndex: 2,
      align: 'center',
    });
  } finally {
    act(() => root.unmount());
  }
});
