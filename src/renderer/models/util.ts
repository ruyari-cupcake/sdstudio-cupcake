import ExifReader from 'exifreader';
import {
  identifyNaiMetadataModel,
  readNaiImportedModelSettings,
} from '../backends/genVendors/naiModelMetadata';
import type { CharacterPrompt, ImportableMetadata } from './types';
import { extractSDStudioMetadataFromBase64 } from '../../shared/sdstudioImageMetadata';

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// danbooru 미러(웹 검색 탭 기본값과 동일)
export const DANBOORU_MIRROR = 'https://hijiribe.donmai.us';

// 드래그한 프롬프트 텍스트를 danbooru 태그 검색 URL로 변환한다.
// - 쉼표는 NAI 프롬프트의 태그 구분자 → danbooru에선 공백이 태그 구분자이므로 분리 후 공백으로 결합
// - 태그 내부 공백은 언더바(_)로 치환 (danbooru는 태그 내부 공백을 허용하지 않음)
// - danbooru에 없는 문법 요소(::, <>, {}, [], (), 가중치 숫자, artist:)는 제거
export function buildDanbooruSearchUrl(rawText: string): string | null {
  if (!rawText) return null;
  const tags = rawText
    .split(',')
    .map((tag) => {
      let t = tag;
      t = t.replace(/<[^>]*>/g, ' '); // <...> 블록 제거 (lora 등)
      t = t.replace(/-?\d*\.?\d+\s*::/g, ' '); // 1.3:: 형태 가중치 제거
      t = t.replace(/::/g, ' '); // 남은 :: 제거
      // "artist:" 접두 제거. 드래그 시 앞부분을 덜 잡아 "artist"의 일부만 남는 경우
      // (rtist:/tist:/ist:/st:/t:)도 "artist"의 접미사이므로 함께 제거한다.
      t = t.replace(/^\s*(?:artist|rtist|tist|ist|st|t):\s*/i, '');
      t = t.replace(/:\s*-?\d*\.?\d+/g, ' '); // :1.2 형태 가중치 제거
      t = t.replace(/[{}[\]<>|]/g, ' '); // {} [] <> | 등 문법 제거 (소괄호 ()는 danbooru 태그에서 쓰이므로 보존)
      t = t.trim().replace(/\s+/g, '_'); // 태그 내부 공백 → 언더바
      t = t.replace(/^_+|_+$/g, ''); // 가장자리 언더바 정리
      return t;
    })
    .filter((t) => t.length > 0);
  if (tags.length === 0) return null;
  return `${DANBOORU_MIRROR}/posts?tags=${encodeURIComponent(tags.join(' '))}`;
}

export async function getPlatform() {
  const { platform } = window.navigator;
  if (platform.startsWith('Win')) return 'windows';
  // 리눅스 데스크톱. (안드로이드도 navigator.platform 이 Linux 로 시작하지만
  // 이 함수는 데스크톱 전용 LocalAI 다운로드 링크에서만 쓰인다)
  if (platform.startsWith('Linux')) return 'linux';
  const arch = await (navigator as any).userAgentData.getHighEntropyValues([
    'architecture',
  ]);
  if (arch.architecture === 'arm64') return 'mac-arm64';
  return 'mac-x64';
}

export { getFirstFile } from './fileSelection';

function base64ToArrayBuffer(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;

  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer;
}

export async function extractExifFromBase64(base64: string) {
  const arrayBuffer = base64ToArrayBuffer(base64);
  const exif = ExifReader.load(arrayBuffer);
  return exif;
}

const STEALTH_MAGIC = 'stealth_pngcomp';

async function decompressGzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const writing = (async () => {
    await writer.write(data as BufferSource);
    await writer.close();
  })();
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  })();
  const [decoded] = await Promise.all([reading, writing]);
  return decoded;
}

function loadImageFromBase64(base64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/png;base64,${base64}`;
  });
}

export async function extractMetadataFromAlpha(
  base64: string,
): Promise<any | undefined> {
  try {
    const img = await loadImageFromBase64(base64);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const pixels = imageData.data;
    const { width } = img;
    const { height } = img;

    // One alpha LSB is one payload bit, in column-major order. Inspect the
    // header first: an ordinary PNG needs no image-sized bit/byte scratch arrays.
    const totalPixels = width * height;
    const headerBits = (STEALTH_MAGIC.length + 4) * 8;
    if (
      !Number.isSafeInteger(totalPixels) ||
      totalPixels < headerBits ||
      pixels.length < totalPixels * 4
    )
      return undefined;

    let bitOffset = 0;
    const readByte = () => {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        value *= 2;
        if (bitOffset < totalPixels) {
          const x = Math.floor(bitOffset / height);
          const y = bitOffset % height;
          value += pixels[(y * width + x) * 4 + 3] % 2;
        }
        bitOffset += 1;
      }
      return value;
    };

    for (let i = 0; i < STEALTH_MAGIC.length; i += 1) {
      if (readByte() !== STEALTH_MAGIC.charCodeAt(i)) return undefined;
    }

    // Multiplication preserves an unsigned 32-bit value; bitwise << 24 would
    // turn lengths with their top bit set into negative numbers.
    let lengthBits = 0;
    for (let i = 0; i < 4; i += 1) lengthBits = lengthBits * 256 + readByte();
    if (lengthBits === 0 || lengthBits > totalPixels - headerBits)
      return undefined;

    // Preserve the existing ceil(bits / 8) convention, including zero padding
    // when the final source byte ends at the image boundary.
    const compressed = new Uint8Array(Math.ceil(lengthBits / 8));
    for (let i = 0; i < compressed.length; i += 1) compressed[i] = readByte();
    const decompressed = await decompressGzip(compressed);
    const jsonString = new TextDecoder().decode(decompressed);
    const metadata = JSON.parse(jsonString);

    // The Comment field may be a nested JSON string
    if (metadata.Comment && typeof metadata.Comment === 'string') {
      metadata.Comment = JSON.parse(metadata.Comment);
    }

    return metadata;
  } catch {
    return undefined;
  }
}

export function buildNaiMetadataDiagnostics(
  data: any,
  source?: string,
): NonNullable<ImportableMetadata['naiDiagnostics']> {
  const finiteNumber = (value: unknown): number | undefined => {
    if (value === null || value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const paramsVersion = finiteNumber(data?.params_version);
  const metadataVersion = finiteNumber(data?.version);
  const qualityHint = finiteNumber(data?.tag_hint_qt);
  const ucHint = finiteNumber(data?.tag_hint_uc_preset);
  const modelName =
    typeof data?.model_name === 'string' ? data.model_name.trim() : '';
  const modelHash =
    typeof data?.model_hash === 'string' ? data.model_hash.trim() : '';
  const requestType =
    typeof data?.request_type === 'string' ? data.request_type.trim() : '';
  const sourceText =
    source ||
    (typeof data?.model === 'string' ? data.model : '') ||
    [modelName, modelHash].filter(Boolean).join(' ');
  const detectedModel = identifyNaiMetadataModel(data, source).label;
  return {
    model: detectedModel,
    modelHash: modelHash || undefined,
    source: sourceText || undefined,
    paramsVersion,
    metadataVersion,
    requestType: requestType || undefined,
    qualityHint,
    ucHint,
    transparentBackground: data?.tag_hint_transparent_background === true,
    straightAlpha:
      typeof data?.straight_alpha === 'boolean'
        ? data.straight_alpha
        : undefined,
    noiseSchedule:
      typeof data?.noise_schedule === 'string'
        ? data.noise_schedule
        : undefined,
  };
}

function parseCommentToJob(
  data: any,
  source?: string,
): ImportableMetadata | undefined {
  if (!data || typeof data.prompt !== 'string') return undefined;
  try {
    // v4 캐릭터 프롬프트 추출 (실패 시 빈 배열로 폴백)
    const characterPrompts: CharacterPrompt[] = [];
    let useCoords = false;
    let legacyPromptConditioning = false;
    try {
      const charCaptions = data.v4_prompt?.caption?.char_captions || [];
      const charUCCaptions =
        data.v4_negative_prompt?.caption?.char_captions || [];
      for (let i = 0; i < charCaptions.length; i++) {
        characterPrompts.push({
          id: `${i}`,
          prompt: charCaptions[i]?.char_caption ?? '',
          position: charCaptions[i]?.centers?.[0],
          uc: charUCCaptions[i]?.char_caption ?? '',
        });
      }
      useCoords = data.v4_prompt?.use_coords ?? false;
      legacyPromptConditioning = data.v4_negative_prompt?.legacy_uc ?? false;
    } catch {
      // v4 포맷 없음 — 폴백
    }

    // 바이브 트랜스퍼 데이터 추출
    const vibeImages: string[] = data.reference_image_multiple || [];
    const vibeStrengths: number[] = data.reference_strength_multiple || [];
    const vibeInfos: number[] =
      data.reference_information_extracted_multiple || [];
    const vibes = vibeStrengths.map((strength, i) => ({
      path: '',
      strength,
      info: vibeInfos[i] ?? 1,
    }));

    // 캐릭터 레퍼런스 데이터 추출
    const refImages: string[] = data.director_reference_images || [];
    const refStrengths: number[] =
      data.director_reference_strength_values || [];
    const refFidelities: number[] = (
      data.director_reference_secondary_strength_values || []
    ).map((v: number) => 1 - v);
    const refInfos: number[] =
      data.director_reference_information_extracted || [];
    const refDescs: any[] = data.director_reference_descriptions || [];
    const characterReferences = refStrengths.map((strength, i) => ({
      path: '',
      strength,
      fidelity: refFidelities[i] ?? 1,
      info: refInfos[i] ?? 1,
      referenceType: (refDescs[i]?.caption?.base_caption || 'character') as
        | 'character'
        | 'style'
        | 'character&style',
      enabled: true,
    }));

    // 해상도 추출
    const resolution =
      data.width && data.height
        ? { width: data.width, height: data.height }
        : undefined;

    return {
      prompt: data.prompt,
      seed: data.seed,
      promptGuidance: data.scale,
      cfgRescale: data.cfg_rescale,
      sampling: data.sampler,
      noiseSchedule: data.noise_schedule,
      steps: data.steps,
      uc:
        data.uc ??
        data.negative_prompt ??
        data.v4_negative_prompt?.caption?.base_caption ??
        '',
      vibes,
      normalizeStrength: data.normalize_reference_strength_multiple ?? true,
      varietyPlus: !!data.skip_cfg_above_sigma,
      deliberateEulerAncestralBug: data.deliberate_euler_ancestral_bug ?? false,
      characterReferences,
      backend: { type: 'NAI' },
      useCoords,
      legacyPromptConditioning,
      characterPrompts,
      vibeImageData: vibeImages.length > 0 ? vibeImages : undefined,
      referenceImageData: refImages.length > 0 ? refImages : undefined,
      resolution,
      naiDiagnostics: buildNaiMetadataDiagnostics(data, source),
      naiModelSettings: readNaiImportedModelSettings(data, source),
    };
  } catch {
    return undefined;
  }
}

export async function extractPromptDataFromBase64(
  base64: string,
): Promise<ImportableMetadata | undefined> {
  const sdstudioMetadata = extractSDStudioMetadataFromBase64(base64);
  const attachSDStudioMetadata = (
    result: ImportableMetadata | undefined,
  ): ImportableMetadata | undefined => {
    if (result && sdstudioMetadata) result.sdstudioMetadata = sdstudioMetadata;
    return result;
  };
  // 1차: EXIF 에서 추출 시도.
  //  - PNG: tEXt 'Comment' 에 NAI JSON
  //  - WebP/AVIF: 변환 시 EXIF 'ImageDescription' 으로 이월됨 (sharp withMetadata)
  try {
    const exif = await extractExifFromBase64(base64);
    const raw =
      (exif.Comment && (exif.Comment.value as string)) ||
      (exif.ImageDescription &&
        ((exif.ImageDescription.value as any) ??
          exif.ImageDescription.description));
    if (raw) {
      const data = JSON.parse(
        Array.isArray(raw) ? (raw as any[]).join('') : (raw as string),
      );
      const sourceRaw = exif.Source?.value;
      const source = Array.isArray(sourceRaw)
        ? sourceRaw.join('')
        : typeof sourceRaw === 'string'
          ? sourceRaw
          : exif.Source?.description;
      const result = parseCommentToJob(data, source);
      if (result) return attachSDStudioMetadata(result);
    }
  } catch {
    // EXIF 추출 실패 — 스테가노그래피로 폴백
  }

  // 2차: 알파 채널 스테가노그래피에서 추출 시도
  try {
    const metadata = await extractMetadataFromAlpha(base64);
    if (metadata) {
      const commentData = metadata.Comment || metadata;
      const source =
        typeof metadata.Source === 'string' ? metadata.Source : undefined;
      const result = parseCommentToJob(commentData, source);
      if (result) return attachSDStudioMetadata(result);
    }
  } catch {
    // 스테가노그래피 추출도 실패
  }

  return undefined;
}

export function assert(condition: any, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
