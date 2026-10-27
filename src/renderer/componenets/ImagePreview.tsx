import React, { useEffect, useRef, useState } from 'react';
import { imageService } from '../models';
import type PreviewReadScope from './PreviewReadScope';

// One observer serves all mounted previews. The last unmount disconnects it so
// neither DOM nodes nor payload-owning callbacks survive their views.
const visibilityListeners = new Map<Element, (visible: boolean) => void>();
let visibilityObserver: IntersectionObserver | undefined;

function observeVisibility(
  element: Element,
  onVisible: (visible: boolean) => void,
) {
  if (typeof IntersectionObserver === 'undefined') {
    onVisible(true);
    return undefined;
  }
  if (!visibilityObserver) {
    visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        visibilityListeners.get(entry.target)?.(entry.isIntersecting);
      }
    });
  }
  visibilityListeners.set(element, onVisible);
  visibilityObserver.observe(element);
  return () => {
    visibilityListeners.delete(element);
    visibilityObserver?.unobserve(element);
    if (visibilityListeners.size === 0) {
      visibilityObserver?.disconnect();
      visibilityObserver = undefined;
    }
  };
}

export interface ImagePreviewProps {
  path: string;
  /** -1 preserves the full-resolution detail view; grids request derived thumbnails. */
  size: number;
  alt: string;
  className?: string;
  imageClassName?: string;
  placeholder?: React.ReactNode;
  scope?: PreviewReadScope;
}

export default function ImagePreview({
  path,
  size,
  alt,
  className,
  imageClassName = 'object-cover',
  placeholder,
  scope,
}: ImagePreviewProps) {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(scope?.isPaused ?? false);
  const [image, setImage] = useState<{
    path: string;
    size: number;
    data: string;
  } | null>(null);

  useEffect(() => {
    if (!element.current) return undefined;
    return observeVisibility(element.current, setVisible);
  }, []);

  useEffect(() => {
    const update = () => setPaused(scope?.isPaused ?? false);
    update();
    scope?.addEventListener('change', update);
    return () => scope?.removeEventListener('change', update);
  }, [scope]);

  useEffect(() => {
    // A thumbnail outside the viewport must release its React-held data URI;
    // ImageService's byte-bounded cache remains the only reusable payload owner.
    setImage(null);
    if (!visible || paused) return undefined;
    let active = true;
    let revision = 0;
    const load = async () => {
      const current = ++revision;
      const read = () =>
        size === -1
          ? imageService.fetchImage(path)
          : imageService.fetchImageSmall(path, size);
      try {
        const data = scope ? await scope.read(read) : await read();
        if (active && current === revision) {
          setImage(data ? { path, size, data } : null);
        }
      } catch (error) {
        if (active && current === revision) {
          setImage(null);
          console.warn('이미지 미리보기를 읽지 못했습니다.', path, error);
        }
      }
    };
    const invalidate = (event: Event) => {
      const { detail } = event as CustomEvent<{
        path?: string;
        paths?: string[];
      }>;
      if (detail?.path === path || detail?.paths?.includes(path)) {
        setImage(null);
        void load();
      }
    };
    imageService.addEventListener('image-cache-invalidated', invalidate);
    void load();
    return () => {
      active = false;
      imageService.removeEventListener('image-cache-invalidated', invalidate);
    };
  }, [path, size, visible, paused, scope]);

  const data =
    visible && !paused && image?.path === path && image.size === size
      ? image.data
      : null;
  return (
    <span
      ref={element}
      className={`block ${className ?? ''}`}
      data-image-preview={path}
      data-preview-size={size}
    >
      {data ? (
        <img
          src={data}
          alt={alt}
          className={`w-full h-full ${imageClassName}`}
          draggable={false}
        />
      ) : (
        <span className="w-full h-full flex items-center justify-center bg-[var(--c-surface)] text-faint">
          {placeholder}
        </span>
      )}
    </span>
  );
}
