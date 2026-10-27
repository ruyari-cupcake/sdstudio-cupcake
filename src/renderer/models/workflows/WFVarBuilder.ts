import type { WFSelectItem, WFVar } from './WorkFlow';
import type { CharacterPrompt, ModelBackend } from '../types';

export class WFVarBuilder {
  private vars: WFVar[] = [];

  clone() {
    const newBuilder = new WFVarBuilder();
    newBuilder.vars = this.vars.slice();
    return newBuilder;
  }

  addIntVar(
    name: string,
    min: number,
    max: number,
    step: number,
    defaultValue: number,
  ): this {
    this.vars.push({
      type: 'int',
      name,
      min,
      max,
      step,
      default: defaultValue,
    });
    return this;
  }

  addNullIntVar(name: string): this {
    this.vars.push({
      type: 'nullInt',
      name,
    });
    return this;
  }

  addVibeSetVar(name: string): this {
    this.vars.push({
      type: 'vibeSet',
      name,
    });
    return this;
  }

  addSamplingVar(name: string, defaultValue: string): this {
    this.vars.push({
      type: 'sampling',
      name,
      default: defaultValue,
    });
    return this;
  }

  addNoiseScheduleVar(name: string, defaultValue: string): this {
    this.vars.push({
      type: 'noiseSchedule',
      name,
      default: defaultValue,
    });
    return this;
  }

  addBoolVar(name: string, defaultValue: boolean): this {
    this.vars.push({
      type: 'bool',
      name,
      default: defaultValue,
    });
    return this;
  }

  addPromptVar(name: string, defaultValue: string): this {
    this.vars.push({
      type: 'prompt',
      name,
      default: defaultValue,
    });
    return this;
  }

  addImageVar(name: string): this {
    this.vars.push({
      type: 'image',
      name,
    });
    return this;
  }

  addMaskVar(name: string, imageRef: string): this {
    this.vars.push({
      type: 'mask',
      name,
      imageRef,
    });
    return this;
  }

  addBackendVar(name: string, defaultValue: ModelBackend): this {
    this.vars.push({
      type: 'backend',
      name,
      default: defaultValue,
    });
    return this;
  }

  addStringVar(name: string, defaultValue: string): this {
    this.vars.push({
      type: 'string',
      name,
      default: defaultValue,
    });
    return this;
  }

  addSelectVar(
    name: string,
    options: WFSelectItem[],
    defaultValue: string,
  ): this {
    this.vars.push({
      type: 'select',
      name,
      options,
      default: defaultValue,
    });
    return this;
  }

  addCharacterPromptsVar(name: string, defaultValue: CharacterPrompt[]): this {
    this.vars.push({
      type: 'characterPrompts',
      name,
      default: defaultValue,
    });
    return this;
  }

  addCharacterReferenceVar(name: string): this {
    this.vars.push({
      type: 'characterReferences',
      name,
    });
    return this;
  }

  build(): WFVar[] {
    return this.vars;
  }
}
