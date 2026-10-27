/** @jest-environment jsdom */
const mockExposeInMainWorld = jest.fn();
const mockGetPathForFile = jest.fn();
jest.mock(
  'electron',
  () => ({
    contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
    ipcRenderer: {
      on: jest.fn(),
      once: jest.fn(),
      invoke: jest.fn(),
      removeListener: jest.fn(),
    },
    webUtils: { getPathForFile: mockGetPathForFile },
  }),
  { virtual: true },
);

function exposedBridge() {
  jest.isolateModules(() => {
    jest.requireActual('../../../main/preload');
  });
  const { calls } = mockExposeInMainWorld.mock;
  return calls[calls.length - 1][1];
}

beforeEach(() => jest.clearAllMocks());

test('the actual preload bridge resolves a selected File through webUtils without forwarding it to main IPC', () => {
  const file = new File(['backup'], 'project.tar');
  mockGetPathForFile.mockReturnValue('/selected/project.tar');
  const bridge = exposedBridge();
  expect(mockExposeInMainWorld).toHaveBeenCalledWith(
    'electron',
    expect.any(Object),
  );
  expect(bridge.getPathForFile(file)).toBe('/selected/project.tar');
  expect(mockGetPathForFile).toHaveBeenCalledWith(file);
  expect(
    jest.requireMock('electron').ipcRenderer.invoke,
  ).not.toHaveBeenCalled();
});

test('the preload capability returns no path for a synthetic File', () => {
  mockGetPathForFile.mockReturnValue('');
  expect(
    exposedBridge().getPathForFile(new File([], 'project.tar')),
  ).toBeUndefined();
});

test('the preload capability handles an invalid renderer argument without exposing Electron objects', () => {
  mockGetPathForFile.mockImplementation(() => {
    throw new TypeError('Expected File');
  });
  expect(
    exposedBridge().getPathForFile({ name: 'project.tar' }),
  ).toBeUndefined();
});
