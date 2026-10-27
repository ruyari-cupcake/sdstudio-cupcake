jest.mock('..', () => {
  throw new Error('Global presets must not construct application services');
});

it('constructs the global preset library without IO through explicitly supplied capabilities', () => {
  const { GlobalPresetService } = jest.requireActual<
    typeof import('../GlobalPresetService')
  >('../GlobalPresetService');
  const backend = {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    renameFile: jest.fn(),
    existFile: jest.fn(),
    readDataFile: jest.fn(),
    writeDataFile: jest.fn(),
    deleteFile: jest.fn(),
    copyFile: jest.fn(),
  };
  const images = { fetchVibeImage: jest.fn(), storeVibeImage: jest.fn() };
  const workflows = { buildPreset: jest.fn(), presetFromJSON: jest.fn() };
  const service = new GlobalPresetService(backend, images, workflows);

  expect(service.loaded).toBe(false);
  expect(service.presets).toEqual([]);
  expect(backend.readFile).not.toHaveBeenCalled();
  expect(images.fetchVibeImage).not.toHaveBeenCalled();
  expect(workflows.buildPreset).not.toHaveBeenCalled();
});
