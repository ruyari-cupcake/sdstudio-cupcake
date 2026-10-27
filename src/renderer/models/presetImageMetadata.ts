import extractChunks from 'png-chunks-extract';
import { Buffer } from 'buffer';
import * as PngChunk from 'png-chunk-text';
import encodeChunks from 'png-chunks-encode';
import { Sampling } from '../backends/imageGen';
import { dataUriToBase64 } from './imageDataUri';

export function embedJSONInPNG(inputBase64: string, jsonData: any) {
  const inputBuffer = Buffer.from(inputBase64, 'base64');
  // buffer 폴리필의 Buffer 는 Uint8Array 서브클래스 — 제네릭 표기 차이만 있어 캐스트
  const chunks = extractChunks(inputBuffer as unknown as Uint8Array);

  const jsonTextChunk = PngChunk.encode(
    'tEXt',
    `json:${Buffer.from(JSON.stringify(jsonData)).toString('base64')}`,
  );
  chunks.splice(1, 0, jsonTextChunk);
  const outputBuffer = Buffer.from(encodeChunks(chunks));
  const outputBase64 = outputBuffer.toString('base64');
  return outputBase64;
}

export function readJSONFromPNG(base64PNG: string) {
  try {
    const buffer = Buffer.from(base64PNG, 'base64');
    const chunks = extractChunks(buffer as unknown as Uint8Array);
    for (const chunk of chunks) {
      if (chunk.name !== 'tEXt') continue;
      const text = Buffer.from(chunk.data).toString();
      const marker = text.indexOf('json:');
      if (marker < 0) continue;
      // Preserve the first marked preset's authority. A corrupt primary
      // payload must not silently revive older metadata later in the PNG.
      return JSON.parse(
        Buffer.from(text.slice(marker + 5), 'base64').toString(),
      );
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 레거시 프리셋 JSON을 현재 스키마로 정규화.
 * - type === 'style' 이면 SDImageGenEasy로 변환
 * - 다른 타입이면 그대로 반환
 */
export function normalizePresetJson(json: any): any {
  if (!json || !json.type) return json;
  if (json.type === 'style') {
    const newJson: any = {};
    newJson.type = 'SDImageGenEasy';
    newJson.name = json.name;
    newJson.profile = json.profile;
    newJson.sampling = json.sampling ?? Sampling.KEulerAncestral;
    newJson.noiseSchedule = json.noiseSchedule ?? 'karras';
    newJson.promptGuidance = json.promptGuidance ?? 5;
    newJson.cfgRescale = json.cfgRescale ?? 0;
    newJson.frontPrompt = json.frontPrompt;
    newJson.backPrompt = json.backPrompt;
    newJson.uc = json.uc;
    newJson.steps = json.steps ?? 28;
    return newJson;
  }
  return json;
}

export function createImageWithText(
  width: number,
  height: number,
  text: string,
  fontSize: number = 30,
  fontFamily: string = 'Arial',
  textColor: string = 'black',
  backgroundColor: string = 'white',
) {
  const canvas: HTMLCanvasElement = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Unable to get 2D context from canvas');
  }

  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = textColor;
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillText(text, width / 2, height / 2);

  return dataUriToBase64(canvas.toDataURL('image/png'));
}
