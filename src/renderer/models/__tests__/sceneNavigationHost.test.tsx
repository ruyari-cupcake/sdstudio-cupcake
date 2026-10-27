/** @jest-environment jsdom */
import React, { useRef, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SceneNavigationCoordinator } from '../sceneNavigation';
import {
  useSceneNavigationHost,
  useSceneNavigationTabs,
} from '../../componenets/sceneNavigationHost';

const scene = { name: 'target', type: 'inpaint' };
const session: any = {
  name: 'project',
  scenes: new Map(),
  inpaints: new Map([['target', scene]]),
};
const target = {
  sessionName: 'project',
  sceneType: 'inpaint' as const,
  sceneName: 'target',
  filename: 'chosen.png',
  openGrid: false,
};

function View({
  navigation,
  opened,
  activate = true,
}: {
  navigation: SceneNavigationCoordinator;
  opened: jest.Mock;
  activate?: boolean;
}) {
  const [active, setActive] = useState<'scene' | 'inpaint'>('scene');
  const [search, setSearch] = useState('hidden by the previous search');
  const [overlay, setOverlay] = useState(true);
  const grid = useRef<HTMLDivElement>(null);
  useSceneNavigationTabs(
    'project',
    (type) => {
      if (activate) setActive(type);
    },
    navigation,
  );
  useSceneNavigationHost(
    {
      session,
      type: 'inpaint',
      enabled: true,
      isActive: active === 'inpaint',
      gridRef: grid,
      searchQuery: search,
      clearSearch: () => setSearch(''),
      viewerOpen: overlay,
      closeViewer: () => setOverlay(false),
      openViewer: opened,
    },
    navigation,
  );
  return (
    <>
      <div data-testid="active-tab">{active}</div>
      {overlay && <div data-testid="overlay">Result overlay</div>}
      <div
        ref={grid}
        style={{ display: active === 'inpaint' ? 'block' : 'none' }}
      >
        {!search && <div id="scene-cell-inpaint-target">Target scene</div>}
      </div>
    </>
  );
}

const originalScroll = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  if (originalScroll)
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScroll,
    );
  else delete (HTMLElement.prototype as any).scrollIntoView;
});

test('late-mounted main tab and scene list finish after search and overlay changes are committed', async () => {
  const navigation = new SceneNavigationCoordinator();
  const scrolled = jest.fn(() => {
    expect(screen.queryByTestId('overlay')).toBeNull();
    expect(screen.getByTestId('active-tab').textContent).toBe('inpaint');
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrolled,
  });
  const completed = navigation.request(target);
  jest.advanceTimersByTime(30_000);
  expect(jest.getTimerCount()).toBe(0);
  render(<View navigation={navigation} opened={jest.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  await expect(completed).resolves.toBe(true);
  expect(scrolled).toHaveBeenCalledTimes(1);
  expect(scrolled).toHaveBeenCalledWith({
    behavior: 'smooth',
    block: 'center',
  });
});

test('the mounted owner opens the requested scene and filename without broadcasting a lossy event', async () => {
  const navigation = new SceneNavigationCoordinator();
  const opened = jest.fn();
  const completed = navigation.request({ ...target, openGrid: true });
  render(<View navigation={navigation} opened={opened} />);
  await act(async () => {
    await Promise.resolve();
  });
  await expect(completed).resolves.toBe(true);
  expect(opened).toHaveBeenCalledTimes(1);
  expect(opened).toHaveBeenCalledWith(scene, 'chosen.png');
});

test('unmounting the actual main-tab owner cancels an intent whose view has not become active', async () => {
  const navigation = new SceneNavigationCoordinator();
  const opened = jest.fn();
  const view = render(
    <View navigation={navigation} opened={opened} activate={false} />,
  );
  let completed!: Promise<boolean>;
  act(() => {
    completed = navigation.request(target);
  });
  view.unmount();
  await expect(completed).resolves.toBe(false);
  render(<View navigation={navigation} opened={opened} />);
  expect(opened).not.toHaveBeenCalled();
});
