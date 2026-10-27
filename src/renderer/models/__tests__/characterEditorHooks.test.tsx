/** Actual observer editor transitions; only heavy child widgets and services use the existing fixture mocks. */
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { configure, observable } from 'mobx';

const mockState: any = {
  uiPresetLayout: {},
  uiCompanionSlots: {},
  uiPresetIconRow: false,
  editMode: false,
  curSession: undefined,
  incrementModalOverlay: () => {},
  decrementModalOverlay: () => {},
  pushMessage: () => {},
};

jest.mock('..', () => {
  const { WFWorkFlow } = jest.requireActual('../workflows/WorkFlow');
  const defs = () => {
    const sd = jest.requireActual('../workflows/SDWorkFlow');
    return [sd.SDInpaintDef, sd.SDI2IDef, sd.SDMirrorDef];
  };
  return {
    isMobile: false,
    backend: { getConfig: async () => ({ modelVersion: '4-5-full' }) },
    sessionService: {
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    imageService: {
      getVibeImagePath: () => '',
      fetchVibeImage: async () => '',
    },
    promptService: {},
    taskQueueService: {},
    workFlowService: {
      getVarDef: (type: string, fieldType: string, field: string) => {
        const def = defs().find((d: any) => d.type === type);
        const vars = fieldType === 'preset' ? def.presetVars : def.sharedVars;
        return vars.find((v: any) => v.name === field);
      },
      buildPreset: (type: string) =>
        new WFWorkFlow(defs().find((d: any) => d.type === type)).buildPreset(),
    },
  };
});
jest.mock('../AppService', () => ({ appState: mockState }));
jest.mock('../BackStackService', () => ({
  backStackService: { push: () => ({ remove: () => {} }) },
}));
jest.mock(
  '../../componenets/ModalOverlay',
  () =>
    function MockModalOverlay({
      isOpen,
      title,
      children,
    }: {
      isOpen: boolean;
      title?: React.ReactNode;
      children?: React.ReactNode;
    }) {
      return isOpen ? (
        <div data-testid="overlay">
          <h2>{title}</h2>
          {children}
        </div>
      ) : null;
    },
);
jest.mock('../../componenets/BigPromptEditor', () => ({
  BigPromptEditor: () => null,
}));
jest.mock('../../componenets/SceneEditor', () => ({
  SlotPiece: () => null,
}));
jest.mock('../../componenets/FloatView', () => ({
  FloatView: ({ children }: any) => children,
}));
jest.mock('../../componenets/CharacterPositionOverlay', () => ({
  CharacterPositionOverlay: () => null,
  PositionMarker: () => null,
}));
jest.mock('../../componenets/VibeEditor', () => ({
  EditableSliderValue: () => null,
  VibeEditor: () => null,
  VibeButton: () => <button type="button">바이브 설정</button>,
  VibeImage: () => null,
}));
jest.mock('../../componenets/CharacterReferenceEditor', () => ({
  CharacterReferenceEditor: () => null,
  CharacterReferenceButton: () => (
    <button type="button">캐릭터 레퍼런스</button>
  ),
}));
jest.mock('../../componenets/PortableToolbarButtons', () => ({
  renderCompanionButtons: () => [],
}));
jest.mock('../../componenets/CompanionDnd', () => ({
  CompanionHostRow: ({ children }: React.PropsWithChildren) => children,
}));
jest.mock('../../componenets/PresetLayoutDnd', () => ({
  DraggablePresetRow: ({ children }: React.PropsWithChildren) => children,
  resetPresetOrder: () => {},
  isPresetAnchorKey: () => false,
}));
jest.mock('../../componenets/PromptEditTextArea', () => {
  const R = jest.requireActual('react');
  function MockPromptEditor({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) {
    return (
      <textarea value={value} onChange={(e) => onChange(e.target.value)} />
    );
  }
  return {
    __esModule: true,
    default: MockPromptEditor,
    PromptAccessorySlotContext: R.createContext(null),
  };
});
jest.mock('../../componenets/MobilePromptSheet', () => {
  const R = jest.requireActual('react');
  return {
    PresetCompactContext: R.createContext(false),
    PresetFocusContext: R.createContext(null),
    WFI_KEY_ATTR: 'data-wfi-key',
  };
});
jest.mock(
  '../../componenets/Tooltip',
  () =>
    function MockTooltip({ children }: React.PropsWithChildren) {
      return children;
    },
);
jest.mock('../../componenets/ActionIcon', () => ({ ActionIcon: () => null }));
jest.mock('../../componenets/HelpIcon', () => () => null);
jest.mock('../../componenets/ResolutionPicker', () => ({
  ResolutionPicker: () => null,
  resolutionValueToSize: () => ({ width: 0, height: 0 }),
}));
jest.mock('react-dnd', () => ({
  useDrag: () => [{}, () => {}, () => {}],
  useDrop: () => [{}, () => {}],
}));
jest.mock('react-contexify', () => ({
  useContextMenu: () => ({ show: () => {} }),
}));

// Load the subject after its mock fixtures have been initialized.
const { CharacterPromptEditor } = jest.requireActual<
  typeof import('../../componenets/PreSetEdtior')
>('../../componenets/PreSetEdtior');
const { WFElementContext } = jest.requireActual<
  typeof import('../../componenets/wfElementContext')
>('../../componenets/wfElementContext');
const { default: ErrorBoundary } = jest.requireActual<
  typeof import('../../componenets/AppErrorBoundary')
>('../../componenets/AppErrorBoundary');
const { ModelVersion } = jest.requireActual<
  typeof import('../../backends/imageGen')
>('../../backends/imageGen');

let container: HTMLDivElement;
let root: Root;
let preset: any;
const input = { fieldType: 'preset', field: 'characterPrompts' } as any;

function Harness() {
  const [editing, setEditing] = useState<string | undefined>();
  const context = React.useMemo(
    () => ({
      preset,
      shared: { characterPrompts: [] },
      type: 'SDImageGen',
      editCharacters: editing,
      setEditCharacters: setEditing,
      middlePromptMode: false,
      modelVersion: ModelVersion.V4_5,
    }),
    [editing],
  );
  return (
    <WFElementContext.Provider value={context as any}>
      <button
        type="button"
        data-open-characters
        onClick={() => setEditing(input.field)}
      >
        Open characters
      </button>
      <CharacterPromptEditor input={input} />
    </WFElementContext.Provider>
  );
}

beforeEach(() => {
  configure({ enforceActions: 'never' });
  (global as any).IS_REACT_ACT_ENVIRONMENT = true;
  preset = observable({ characterPrompts: [], useCoords: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

const findButton = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  )!;

test('the actual character editor opens, closes and reopens without changing hook order or entering the error fallback', () => {
  act(() =>
    root.render(
      <ErrorBoundary>
        <Harness />
      </ErrorBoundary>,
    ),
  );
  expect(findButton('캐릭터 추가')).toBeUndefined();
  act(() => findButton('Open characters').click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(findButton('캐릭터 추가')).toBeDefined();
  act(() => findButton('캐릭터 프롬프트 닫기').click());
  expect(findButton('캐릭터 추가')).toBeUndefined();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  act(() => findButton('Open characters').click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  act(() => findButton('캐릭터 추가').click());
  expect(preset.characterPrompts).toHaveLength(1);
});
