jest.mock('..', () => {
  throw new Error('Leaf service imports must not construct the application');
});

describe('explicit leaf service dependencies', () => {
  it.each([
    ['GlobalPieceService', '../GlobalPieceService'],
    ['ArtistLibraryService', '../ArtistLibraryService'],
    ['LoginService', '../LoginService'],
    ['GameService', '../GameService'],
    ['ProjectSizeService', '../ProjectSizeService'],
  ])('loads %s without a composition-root import', (className, modulePath) => {
    const module = jest.requireActual(modulePath);
    expect(typeof module[className]).toBe('function');
  });

  it('wires the supplied game image source at construction and reads the supplied storage', async () => {
    const { GameService } =
      jest.requireActual<typeof import('../GameService')>('../GameService');
    const images = new EventTarget();
    const imageSource = {
      addEventListener: jest.fn(images.addEventListener.bind(images)),
      getOutputs: jest.fn(() => ['one.png']),
    };
    const storage = {
      listFiles: jest.fn(async () => ['one.png', 'notes.txt']),
    };
    const service = new GameService(storage, imageSource);

    expect(imageSource.addEventListener).toHaveBeenCalledTimes(1);
    expect(imageSource.addEventListener).toHaveBeenCalledWith(
      'updated',
      expect.any(Function),
    );
    await expect(service.createGame('outs/fixture')).resolves.toEqual([
      { path: 'one.png', rank: 0 },
    ]);
    expect(storage.listFiles).toHaveBeenCalledWith('outs/fixture');
  });
});
