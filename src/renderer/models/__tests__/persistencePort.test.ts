jest.mock('..', () => {
  throw new Error('Persistence queue must not construct application services');
});

it('persists through the explicitly supplied storage capability without loading the application', async () => {
  const { PersistenceService } = jest.requireActual<
    typeof import('../PersistenceService')
  >('../PersistenceService');
  const storage = { writeFile: jest.fn(async () => undefined) };
  const service = new PersistenceService();

  await service.write(storage, 'project.json', '{"version":1}');
  await service.flushAll();

  expect(storage.writeFile).toHaveBeenCalledTimes(1);
  expect(storage.writeFile).toHaveBeenCalledWith(
    'project.json',
    '{"version":1}',
  );
});
