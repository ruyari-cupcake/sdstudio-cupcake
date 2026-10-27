import { type RefObject, useEffect, useRef, useState } from 'react';
import type { GenericScene, Session } from '../models/types';
import {
  sceneNavigation,
  type SceneNavigationCoordinator,
  type SceneNavigationRequest,
  type SceneNavigationTarget,
} from '../models/sceneNavigation';

/** Register once for the actual main-tab lifetime; a pending intent is replayed on mount. */
export function useSceneNavigationTabs(
  sessionName: string | undefined,
  activate: (type: SceneNavigationTarget['sceneType']) => void,
  coordinator: SceneNavigationCoordinator = sceneNavigation,
) {
  const activateRef = useRef(activate);
  activateRef.current = activate;
  useEffect(() => {
    if (!sessionName) return undefined;
    return coordinator.registerTabHost(sessionName, (type) =>
      activateRef.current(type),
    );
  }, [coordinator, sessionName]);
}

interface SceneNavigationHostOptions {
  session: Session;
  type: 'scene' | 'inpaint';
  enabled: boolean;
  isActive: boolean;
  gridRef: RefObject<HTMLDivElement>;
  searchQuery: string;
  clearSearch: () => void;
  viewerOpen: boolean;
  closeViewer: () => void;
  openViewer: (scene: GenericScene, filename: string) => void;
}

/** Finish after React commits the active list, cleared search and closed overlay. No polling. */
export function useSceneNavigationHost(
  options: SceneNavigationHostOptions,
  coordinator: SceneNavigationCoordinator = sceneNavigation,
) {
  const {
    session,
    type,
    enabled,
    isActive,
    gridRef,
    searchQuery,
    clearSearch,
    viewerOpen,
    closeViewer,
    openViewer,
  } = options;
  const [request, setRequest] = useState<SceneNavigationRequest>();
  useEffect(() => {
    if (!enabled) return undefined;
    return coordinator.registerSceneHost(session.name, type, setRequest);
  }, [coordinator, enabled, session.name, type]);

  useEffect(() => {
    if (!enabled || !isActive || !request?.isCurrent()) return;
    const { target } = request;
    if (target.sessionName !== session.name || target.sceneType !== type)
      return;
    const scene =
      type === 'scene'
        ? session.scenes.get(target.sceneName)
        : session.inpaints.get(target.sceneName);
    if (!scene) {
      request.cancel();
      return;
    }
    if (searchQuery) {
      clearSearch();
      return;
    }
    if (target.openGrid) {
      openViewer(scene, target.filename);
      request.complete();
      return;
    }
    if (viewerOpen) {
      closeViewer();
      return;
    }
    const cellId = `scene-cell-${type}-${target.sceneName}`;
    const cell = Array.from(
      gridRef.current?.querySelectorAll<HTMLElement>('[id]') ?? [],
    ).find((candidate) => candidate.id === cellId);
    if (!cell?.isConnected) return;
    cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
    request.complete();
  }, [
    request,
    enabled,
    isActive,
    session,
    type,
    gridRef,
    searchQuery,
    clearSearch,
    viewerOpen,
    closeViewer,
    openViewer,
  ]);
}
