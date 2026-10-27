jest.mock('..', () => {
  throw new Error('Domain imports must not construct application services');
});

function loadDomain() {
  return jest.requireActual<typeof import('../types')>('../types');
}

describe('workflow domain isolation', () => {
  it('loads data types without constructing backend or application services', () => {
    const domain = loadDomain();

    expect(new domain.VibeItem().toJSON()).toEqual({
      path: '',
      info: 0,
      strength: 0,
      fromPreset: undefined,
    });
    expect(new domain.ReferenceItem().toJSON()).toEqual({
      path: '',
      info: 1,
      strength: 0.6,
      fidelity: 1,
      referenceType: 'character',
      enabled: true,
      fromPreset: undefined,
    });
  });

  it('preserves constructor identity and reference values across workflow serialization', () => {
    const domain = loadDomain();
    const { WFWorkFlow } = jest.requireActual<
      typeof import('../workflows/WorkFlow')
    >('../workflows/WorkFlow');
    const workflow = new WFWorkFlow({
      type: 'domain-isolation-fixture',
      title: 'Domain isolation fixture',
      backendType: 'none',
      presetVars: [
        { type: 'vibeSet', name: 'vibes' },
        { type: 'characterReferences', name: 'references' },
      ],
      sharedVars: [],
      metaVars: [],
      editor: { type: 'stack', inputs: [] },
      innerEditor: { type: 'stack', inputs: [] },
      i2i: false,
      handler: jest.fn(),
    });
    const vibes = [{ path: 'vibes/one.png', info: 0.75, strength: 0.25 }];
    const references = [
      {
        path: 'references/one.png',
        info: 0.4,
        strength: 0.8,
        fidelity: 0.9,
        referenceType: 'style' as const,
        enabled: false,
        fromPreset: 'fixture',
      },
    ];

    const preset = workflow.presetFromJSON({
      type: 'domain-isolation-fixture',
      name: 'identity',
      vibes,
      references,
    });

    expect(preset.vibes[0]).toBeInstanceOf(domain.VibeItem);
    expect(preset.references[0]).toBeInstanceOf(domain.ReferenceItem);
    expect(preset.vibes[0].toJSON()).toEqual({
      ...vibes[0],
      fromPreset: undefined,
    });
    expect(preset.references[0].toJSON()).toEqual(references[0]);
    expect(preset.toJSON()).toEqual(
      expect.objectContaining({ vibes, references }),
    );
  });

  it('deserializes scenes through the same explicitly populated registry', () => {
    const domain = loadDomain();
    // This lookup intentionally follows loadDomain so the RED phase detects
    // application construction, rather than an as-yet unextracted module.
    const { workFlowService } = jest.requireActual(
      '../workflows/workflowRegistry',
    ) as {
      workFlowService: import('../workflows/WorkFlowService').WorkFlowService;
    };
    const definition = {
      type: 'domain-scene-fixture',
      title: 'Domain scene fixture',
      backendType: 'none' as const,
      presetVars: [{ type: 'string' as const, name: 'prompt', default: '' }],
      sharedVars: [],
      metaVars: [],
      editor: { type: 'stack' as const, inputs: [] },
      innerEditor: { type: 'stack' as const, inputs: [] },
      i2i: true,
      handler: jest.fn(),
    };
    workFlowService.addWorkFlow(0, definition);
    try {
      const scene = domain.InpaintScene.fromJSON({
        type: 'inpaint',
        name: 'isolated scene',
        workflowType: definition.type,
        resolution: 'normal_square',
        imageMap: [],
        mains: [],
        preset: { type: definition.type, name: 'fixture', prompt: 'kept' },
      });

      expect(scene).not.toBeNull();
      expect(scene?.preset.type).toBe(definition.type);
      expect(scene?.preset.prompt).toBe('kept');
      expect(scene?.preset.toJSON()).toEqual(
        expect.objectContaining({
          type: definition.type,
          name: 'fixture',
          prompt: 'kept',
        }),
      );
    } finally {
      workFlowService.workflows.delete(definition.type);
    }
  });
});
