jest.mock('..', () => {
  throw new Error(
    'Resource synchronization must not construct application services',
  );
});

it('loads resource synchronization independently of the composition root', () => {
  const { ResourceSyncService } = jest.requireActual<
    typeof import('../ResourceSyncService')
  >('../ResourceSyncService');

  expect(Object.getPrototypeOf(ResourceSyncService.prototype)).toBe(
    EventTarget.prototype,
  );
});
