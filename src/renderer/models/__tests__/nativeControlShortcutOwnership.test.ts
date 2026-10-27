/** @jest-environment jsdom */
import { KeyboardShortcutService } from '../KeyboardShortcutService';
import { appState } from '../AppService';

// The class is real; mobile=true prevents its module singleton from installing
// an additional capture listener alongside the explicitly owned fixture.
jest.mock('..', () => ({ isMobile: true }));
jest.mock('../AppService', () => ({
  appState: {
    modalOverlayCount: 0,
    imageGridFocusable: false,
    resultViewerOpen: false,
    floatViewCount: 0,
    dialogs: [],
    configScreenOpen: false,
    pieceEditorOpen: false,
    findReplaceOpen: false,
  },
}));

let service: KeyboardShortcutService;
let host: HTMLDivElement;
const shortcut = jest.fn();
const keyboardState = appState as unknown as {
  modalOverlayCount: number;
  imageGridFocusable: boolean;
  resultViewerOpen: boolean;
};

beforeEach(() => {
  localStorage.removeItem('sdstudio-key-bindings');
  shortcut.mockClear();
  keyboardState.modalOverlayCount = 0;
  keyboardState.imageGridFocusable = false;
  keyboardState.resultViewerOpen = false;
  service = new KeyboardShortcutService();
  service.install();
  window.addEventListener('shortcut-action', shortcut);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  service.uninstall();
  window.removeEventListener('shortcut-action', shortcut);
  host.remove();
  localStorage.removeItem('sdstudio-key-bindings');
});

function target(markup: string) {
  host.innerHTML = markup;
  const element = host.querySelector<HTMLElement>(
    'button, a[href], summary, select, [tabindex]',
  )!;
  element.focus();
  expect(document.activeElement).toBe(element);
  return element;
}

function press(
  element: HTMLElement,
  key: string,
  modifiers: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  element.dispatchEvent(event);
  return event;
}

test.each([
  {
    kind: 'button',
    markup: '<button type="button">Quota</button>',
    key: 'Enter',
  },
  { kind: 'button', markup: '<button type="button">Quota</button>', key: ' ' },
  { kind: 'link', markup: '<a href="#quota">Quota</a>', key: 'Enter' },
  {
    kind: 'summary',
    markup: '<details><summary tabindex="0">Quota help</summary></details>',
    key: 'Enter',
  },
  {
    kind: 'summary',
    markup: '<details><summary tabindex="0">Quota help</summary></details>',
    key: ' ',
  },
  {
    kind: 'select',
    markup: '<select><option>Quota</option></select>',
    key: 'Enter',
  },
  {
    kind: 'select',
    markup: '<select><option>Quota</option></select>',
    key: ' ',
  },
])(
  '$kind retains its native "$key" activation at the actual window capture boundary',
  ({ markup, key }) => {
    const control = target(markup);
    const reachedControl = jest.fn();
    control.addEventListener('keydown', reachedControl);
    const event = press(control, key);
    expect(event.defaultPrevented).toBe(false);
    expect(reachedControl).toHaveBeenCalledTimes(1);
    expect(shortcut).not.toHaveBeenCalled();
  },
);

test.each([
  ['Enter', 'scene-open-images', 'Shift+Enter'],
  [' ', 'queue-run', 'Shift+Space'],
])(
  'Shift does not remove the focused button native %s activation',
  (key, action, binding) => {
    service.setBinding(action, binding);
    const event = press(target('<button type="button">Quota</button>'), key, {
      shiftKey: true,
    });
    expect(event.defaultPrevented).toBe(false);
    expect(shortcut).not.toHaveBeenCalled();
  },
);

test('bare Enter outside a native control still opens the selected scene', () => {
  const event = press(target('<div tabindex="0">Scene grid</div>'), 'Enter');
  expect(event.defaultPrevented).toBe(true);
  expect(shortcut).toHaveBeenCalledTimes(1);
  expect((shortcut.mock.calls[0][0] as CustomEvent).detail.action).toBe(
    'scene-open-images',
  );
});

test('Ctrl+S remains an app shortcut while a native button is focused', () => {
  const event = press(target('<button type="button">Quota</button>'), 's', {
    ctrlKey: true,
  });
  expect(event.defaultPrevented).toBe(true);
  expect(shortcut).toHaveBeenCalledTimes(1);
  expect((shortcut.mock.calls[0][0] as CustomEvent).detail.action).toBe(
    'scene-toggle-select',
  );
});

test.each(['ctrlKey', 'metaKey', 'altKey'] as const)(
  'an explicit %s Enter app binding remains available on a native button',
  (modifier) => {
    service.setBinding(
      'scene-open-images',
      modifier === 'altKey' ? 'Alt+Enter' : 'Ctrl+Enter',
    );
    const event = press(
      target('<button type="button">Quota</button>'),
      'Enter',
      {
        [modifier]: true,
      },
    );
    expect(event.defaultPrevented).toBe(true);
    expect(shortcut).toHaveBeenCalledTimes(1);
    expect((shortcut.mock.calls[0][0] as CustomEvent).detail.action).toBe(
      'scene-open-images',
    );
  },
);

test.each([
  {
    scope: 'scene Tab',
    key: 'Tab',
    ctrlKey: false,
    grid: false,
    viewer: false,
    action: 'scene-open-editor',
  },
  {
    scope: 'scene modified shortcut',
    key: 's',
    ctrlKey: true,
    grid: false,
    viewer: false,
    action: 'scene-toggle-select',
  },
  {
    scope: 'viewer modified shortcut',
    key: 's',
    ctrlKey: true,
    grid: false,
    viewer: true,
    action: 'save-image',
  },
  {
    scope: 'image-grid modified shortcut',
    key: 's',
    ctrlKey: true,
    grid: true,
    viewer: false,
    action: 'image-toggle-select',
  },
])(
  'an open modal owns $scope keys without cancelling the dialog event',
  ({ key, ctrlKey, grid, viewer, action }) => {
    keyboardState.modalOverlayCount = 1;
    keyboardState.imageGridFocusable = grid;
    keyboardState.resultViewerOpen = viewer;
    const control = target('<button type="button">Dialog action</button>');
    const reachedDialog = jest.fn();
    control.addEventListener('keydown', reachedDialog);
    const event = press(control, key, { ctrlKey });
    expect(event.defaultPrevented).toBe(false);
    expect(reachedDialog).toHaveBeenCalledTimes(1);
    expect(shortcut).not.toHaveBeenCalled();

    // Releasing the modal restores the same underlying shortcut's normal scope.
    keyboardState.modalOverlayCount = 0;
    const afterClose = press(control, key, { ctrlKey });
    expect(afterClose.defaultPrevented).toBe(true);
    expect(shortcut).toHaveBeenCalledTimes(1);
    expect((shortcut.mock.calls[0][0] as CustomEvent).detail.action).toBe(
      action,
    );
  },
);

test.each([
  { scope: 'viewer', grid: false, viewer: true, action: 'save-image' },
  {
    scope: 'image grid',
    grid: true,
    viewer: false,
    action: 'image-toggle-select',
  },
])(
  'preferences owns $scope shortcuts until it closes',
  ({ grid, viewer, action }) => {
    keyboardState.imageGridFocusable = grid;
    keyboardState.resultViewerOpen = viewer;
    appState.configScreenOpen = true;
    const control = target('<button type="button">Preferences action</button>');
    const reachedPreferences = jest.fn();
    control.addEventListener('keydown', reachedPreferences);
    try {
      const event = press(control, 's', { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(reachedPreferences).toHaveBeenCalledTimes(1);
      expect(shortcut).not.toHaveBeenCalled();
      appState.configScreenOpen = false;
      const afterClose = press(control, 's', { ctrlKey: true });
      expect(afterClose.defaultPrevented).toBe(true);
      expect((shortcut.mock.calls[0][0] as CustomEvent).detail.action).toBe(
        action,
      );
    } finally {
      appState.configScreenOpen = false;
    }
  },
);
