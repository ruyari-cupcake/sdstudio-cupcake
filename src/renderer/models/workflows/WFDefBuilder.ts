import type {
  WorkFlowDef,
  WFVar,
  WFBackendType,
  WFIElement,
  WFHandler,
  WFCreatePrompt,
  WFCreateCharacterPrompts,
  WFCreatePreset,
} from './WorkFlow';

export class WFDefBuilder {
  private workflowDef: WorkFlowDef;

  constructor(type: string) {
    this.workflowDef = {
      type,
      presetVars: [],
      sharedVars: [],
      metaVars: [],
      backendType: 'none',
      editor: null as any,
      innerEditor: null as any,
      i2i: false,
      title: '',
      handler: () => {},
    };
  }

  setTitle(title: string): this {
    this.workflowDef.title = title;
    return this;
  }

  setPresetVars(presetVars: WFVar[]): this {
    this.workflowDef.presetVars = presetVars;
    return this;
  }

  setSharedVars(sharedVars: WFVar[]): this {
    this.workflowDef.sharedVars = sharedVars;
    return this;
  }

  setMetaVars(metaVars: WFVar[]): this {
    this.workflowDef.metaVars = metaVars;
    return this;
  }

  setBackendType(backendType: WFBackendType): this {
    this.workflowDef.backendType = backendType;
    return this;
  }

  setEditor(editor: WFIElement): this {
    this.workflowDef.editor = editor;
    return this;
  }

  setInnerEditor(innerEditor: WFIElement): this {
    this.workflowDef.innerEditor = innerEditor;
    return this;
  }

  setI2I(i2i: boolean): this {
    this.workflowDef.i2i = i2i;
    return this;
  }

  setHandler(handler: WFHandler): this {
    this.workflowDef.handler = handler;
    return this;
  }

  setCreatePrompt(createPrompt: WFCreatePrompt): this {
    this.workflowDef.createPrompt = createPrompt;
    return this;
  }

  setCreateCharacterPrompts(
    createCharacterPrompts: WFCreateCharacterPrompts,
  ): this {
    this.workflowDef.createCharacterPrompts = createCharacterPrompts;
    return this;
  }

  setCreatePreset(createPreset: WFCreatePreset): this {
    this.workflowDef.createPreset = createPreset;
    return this;
  }

  setHasMask(hasMask: boolean): this {
    this.workflowDef.hasMask = hasMask;
    return this;
  }

  setEmoji(emoji: string): this {
    this.workflowDef.emoji = emoji;
    return this;
  }

  build(): WorkFlowDef {
    return this.workflowDef;
  }
}
