import { Piece } from './Piece';
import { PieceLibrary } from './PieceLibrary';
import { PromptPiece } from './PromptPiece';
import { AbstractScene } from './AbstractScene';
import { Scene } from './Scene';
import { InpaintScene } from './InpaintScene';
import { Session } from './Session';
import { CharacterPreset } from './CharacterPreset';
import type {
  AugmentMethod,
  ImageSize,
  Resolution,
} from '../backends/imageGen';
import { VibeItem } from './VibeItem';
import { ReferenceItem } from './ReferenceItem';
import type {
  SDStudioImageMetadataV1,
  SDStudioPromptSourceV1,
} from '../../shared/sdstudioImageMetadata';
import type { FocusedInpaintSpec } from './focusedInpaint';
import type { NaiImportedModelSettings } from '../backends/genVendors/naiModelMetadata';
import type { ComboMode } from './comboMode';

export { VibeItem, ReferenceItem };
export {
  Piece,
  PieceLibrary,
  PromptPiece,
  AbstractScene,
  Scene,
  InpaintScene,
  Session,
  CharacterPreset,
};
export { ContextMenuType } from './ContextMenuType';

export type PARR = string[];

export interface IVibeItem {
  path: string;
  info: number;
  strength: number;
  fromPreset?: string;
}

export interface ModelBackend {
  type: 'NAI' | 'SD';
  model?: string;
}

export interface AbstractJob {}

export interface SDAbstractJob<T> extends AbstractJob {
  cfgRescale: number;
  steps: number;
  promptGuidance: number;
  sampling: string;
  prompt: T;
  uc: string;
  characterPrompts: CharacterPrompt<T>[];
  useCoords: boolean;
  legacyPromptConditioning: boolean;
  normalizeStrength: boolean;
  varietyPlus: boolean;
  deliberateEulerAncestralBug?: boolean;
  characterReferences: IReferenceItem[];
  noiseSchedule: string;
  backend: ModelBackend;
  vibes: IVibeItem[];
  overrideResolution?: Resolution | ImageSize;
  seed?: number;
  sdstudioPromptSource?: SDStudioPromptSourceV1;
}

export interface ImportableMetadata extends SDAbstractJob<string> {
  naiModelSettings?: NaiImportedModelSettings;
  vibeImageData?: string[];
  referenceImageData?: string[];
  resolution?: { width: number; height: number };
  naiDiagnostics?: {
    model: string;
    modelHash?: string;
    source?: string;
    paramsVersion?: number;
    metadataVersion?: number;
    requestType?: string;
    qualityHint?: number;
    ucHint?: number;
    transparentBackground: boolean;
    straightAlpha?: boolean;
    noiseSchedule?: string;
  };
  sdstudioMetadata?: SDStudioImageMetadataV1;
}

export interface SDJob extends SDAbstractJob<PromptNode> {
  type: 'sd';
}

export interface SDInpaintJob extends SDAbstractJob<PromptNode> {
  type: 'sd_inpaint';
  mask: string;
  image: string;
  strength: number;
  noise: number;
  originalImage?: boolean;
  /** Focused inpainting 영역(원본 픽셀)·context — 켜진 인페인트 프리셋만(SPEC §7). */
  focus?: FocusedInpaintSpec;
}

export interface SDI2IJob extends SDAbstractJob<PromptNode> {
  type: 'sd_i2i';
  image: string;
  strength: number;
  noise: number;
}

export interface AugmentJob extends AbstractJob {
  type: 'augment';
  image: string;
  method: AugmentMethod;
  prompt?: PromptNode;
  weaken?: number;
  emotion?: string;
  width: number;
  height: number;
  backend: ModelBackend;
}

export interface UpscaleJob extends AbstractJob {
  type: 'upscale';
  backend: ModelBackend;
  image: string;
  /** 대량 예약은 base64 대신 경로를 보관하고 실행 직전에 원본을 읽는다. */
  imagePath?: string;
  resolution: string;
  width: number;
  height: number;
}

export type Job = SDJob | SDInpaintJob | AugmentJob | UpscaleJob | SDI2IJob;

export interface IPiece {
  name: string;
  prompt: string;
  multi?: boolean;
}

export interface IPieceLibrary {
  version: number;
  name: string;
  pieces: IPiece[];
}

export interface IPromptPiece {
  prompt: string;
  characterPrompts: string[];
  id: string;
  enabled?: boolean;
  // 조각(셀) 표시용 이름. 옵셔널 = 하위호환(구버전은 무시, 미설정 시 UI가 "열-행" 기본값 표시).
  // 표시 전용 — 생성 프롬프트 조합에는 영향 없음.
  name?: string;
}

export type IPromptPieceSlot = IPromptPiece[];
export type PromptPieceSlot = PromptPiece[];

export interface Player {
  rank: number;
  path: string;
}

export type Game = Player[];

export interface Round {
  players: string[];
  winMask: boolean[];
  curPlayer: number;
}

export interface IAbstractScene {
  name: string;
  resolution: string;
  resolutionWidth?: number;
  resolutionHeight?: number;
  game?: Game;
  round?: Round;
  imageMap: string[];
  mains: string[];
}

export interface IScene extends IAbstractScene {
  type: 'scene';
  slots: IPromptPieceSlot[];
  meta: Record<string, any>;
  sceneCharacterPrompts?: CharacterPrompt[]; // 씬 전용 캐릭터 프롬프트
  useSceneCharacterPrompts?: boolean; // 씬 전용 캐릭터 프롬프트 사용 여부
  sceneCharacterPromptMode?: 'base' | 'mix' | 'scene'; // 기본/역할 혼합/씬 전용
  sceneCharacterUC?: string; // 씬 전용 캐릭터 네거티브 프롬프트
  sceneUC?: string; // 씬 전용 네거티브 프롬프트 (생성 시 네거티브 뒤에 붙임)
  sceneSeed?: number; // 씬 전용 시드(2026-09-26) — 있으면 그룹 시드·프롬프트 시드보다 우선. 없으면 키 자체를 생략
}

export interface IInpaintScene extends IAbstractScene {
  type: 'inpaint';
  workflowType: string;
  preset?: any;
  sceneRef?: string;
  sourceImage?: string;
  slots?: IPromptPieceSlot[];
  mirrorCropX?: number;
  // I2I 조합 모드(2026-10-04 B4, comboMode.ts·SPEC §7-4) — 없으면 조합 모드 아님(5.4.0 은 무시).
  comboMode?: ComboMode;
}

export function genericSceneFromJSON(json: IGenericScene): GenericScene | null {
  if (json.type === 'scene') {
    return Scene.fromJSON(json);
  }
  return InpaintScene.fromJSON(json);
}

export type IGenericScene = IScene | IInpaintScene;
export type GenericScene = Scene | InpaintScene;

export interface SelectedWorkflow {
  workflowType: string;
  presetName?: string;
}

export interface ISession {
  version: number;
  name: string;
  id?: string; // 세션 전역 유일 식별자(uuid v4). 트랙1 (b) 물리 통합 — 로드 시 지연 발급. 구버전은 미지 필드로 무시(데이터 호환 안전)
  selectedWorkflow?: SelectedWorkflow;
  presets: Record<string, any[]>;
  inpaints: Record<string, IInpaintScene>;
  scenes: Record<string, IScene>;
  library: Record<string, IPieceLibrary>;
  presetShareds: Record<string, any>;
  characterPresets?: Record<string, ICharacterPreset>; // 캐릭터 프리셋
  mirrorImage?: string; // 세션 레벨 미러 원본 이미지 (vibe storage 경로)
  mirrorMode?: 'blank' | 'duplicate'; // 미러 캔버스 모드 (blank=우측 빈 캔버스, duplicate=우측 이미지 복제)
  sceneCardStyle?: { scene?: string; inpaint?: string }; // 탭별 씬 카드 종횡비
  // 새 씬 기본 해상도 (프리셋 패널 하단 컨트롤) — [씬 추가] 시에만 적용, 기존 씬 무영향.
  // 구버전은 미지 필드로 무시(데이터 호환 안전)
  newSceneResolution?: { resolution: string; width?: number; height?: number };
  // 추가 프롬프트 (2026-07-18) — 세션 레벨 필드로만 저장(프리셋/글로벌 프리셋 구조
  // 비대상, 사용자 확정). 구버전은 미지 필드로 무시(데이터 호환 안전)
  extraPrompt?: string;
}

export interface PromptGroupNode {
  type: 'group';
  children: PromptNode[];
  /** 생성 중에만 전달되며 프로젝트 JSON에는 저장되지 않는 프롬프트 구획 정보. */
  sdstudioPromptSource?: SDStudioPromptSourceV1;
}

export interface PromptTextNode {
  type: 'text';
  text: string;
}

export interface PromptRandomNode {
  type: 'random';
  options: PromptNode[];
}

export type PromptNode = PromptGroupNode | PromptTextNode | PromptRandomNode;

export interface ImageContextAlt {
  type: 'image';
  path: string;
  scene?: GenericScene;
  starable?: boolean;
}

export interface GallaryImageContextAlt {
  type: 'gallary_image';
  path: string[];
  scene?: GenericScene;
  starable?: boolean;
}

export interface SceneContextAlt {
  type: 'scene';
  scene: GenericScene;
}

export interface StyleContextAlt {
  type: 'style';
  preset: any;
  container: any;
  session: Session;
}

export interface HistoryImageContextAlt {
  type: 'history_image';
  entry: import('./ImageHistoryService').GenerationHistoryEntry;
}

export type ContextAlt = ImageContextAlt | SceneContextAlt | StyleContextAlt;

export const encodeContextAlt = (x: ContextAlt) => JSON.stringify(x)!;
export const decodeContextAlt = JSON.parse as (x: string) => ContextAlt;

const isSessionMap = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const isValidSession = (session: any) => {
  return (
    !!session &&
    typeof session.name === 'string' &&
    session.presets !== null &&
    typeof session.presets === 'object' &&
    isSessionMap(session.inpaints) &&
    isSessionMap(session.scenes) &&
    isSessionMap(session.library)
  );
};

export const isValidPieceLibrary = (library: any) => {
  return (
    !!library &&
    (typeof library.name === 'string' ||
      typeof library.description === 'string') &&
    (library.version
      ? Array.isArray(library.pieces)
      : isSessionMap(library.pieces))
  );
};

export const isValidNAISPreset = (data: any) => {
  return (
    !!data &&
    typeof data.name === 'string' &&
    Array.isArray(data.scenes) &&
    data.scenes.length > 0 &&
    typeof data.scenes[0]?.scenePrompt === 'string'
  );
};

export function extractNAISPieceNames(scenes: any[]): string[] {
  const names = new Set<string>();
  for (const scene of scenes) {
    const prompt = scene.scenePrompt || '';
    const matches = prompt.matchAll(/<([^.<>]+)>/g);
    for (const m of matches) {
      names.add(m[1]);
    }
  }
  return Array.from(names);
}

export function convertNAISToSession(
  naisData: any,
  libraryName?: string,
): ISession {
  const scenes: Record<string, IScene> = {};
  for (const naisScene of naisData.scenes) {
    let prompt = naisScene.scenePrompt || '';
    if (libraryName) {
      prompt = prompt.replace(/<([^.<>]+)>/g, `<${libraryName}.$1>`);
    }
    scenes[naisScene.name] = {
      name: naisScene.name,
      resolution: 'portrait' as Resolution,
      imageMap: [],
      mains: [],
      type: 'scene',
      slots: [
        [
          {
            prompt,
            characterPrompts: [],
            id: crypto.randomUUID(),
            enabled: true,
          },
        ],
      ],
      meta: {
        SDImageGen: { type: 'SDImageGen' },
        SDImageGenEasy: { type: 'SDImageGenEasy' },
        mirrorMode: true,
      },
      sceneCharacterPrompts: [],
      useSceneCharacterPrompts: false,
      sceneCharacterUC: '',
    } as any;
  }

  return {
    name: naisData.name,
    version: 1,
    selectedWorkflow: {
      workflowType: 'SDImageGen',
      presetName: 'default',
    },
    presets: {
      SDImageGenEasy: [
        {
          type: 'SDImageGenEasy',
          cfgRescale: 0,
          steps: 28,
          promptGuidance: 5,
          sampling: 'k_euler_ancestral',
          frontPrompt: '',
          backPrompt:
            '{best quality, amazing quality, very aesthetic, highres, incredibly absurdres}',
          uc: 'worst quality, bad quality, displeasing, very displeasing, lowres, bad anatomy, bad hands, bad feet, extra digits, fewer digits, missing fingers',
          noiseSchedule: 'karras',
          useCoords: false,
          legacyPromptConditioning: false,
          varietyPlus: false,
          deliberateEulerAncestralBug: false,
          name: 'default',
          profile: '',
          backend: { type: 'NAI' },
        },
      ],
      AugmentGen: [
        {
          type: 'AugmentGen',
          frontPrompt: '',
          backPrompt: '',
          name: 'default',
          profile: '',
          backend: { type: 'NAI' },
        },
      ],
      SDImageGen: [
        {
          type: 'SDImageGen',
          cfgRescale: 0,
          steps: 28,
          promptGuidance: 5,
          sampling: 'k_euler_ancestral',
          frontPrompt: '',
          backPrompt:
            '{best quality, amazing quality, very aesthetic, highres, incredibly absurdres}',
          uc: 'worst quality, bad quality, displeasing, very displeasing, lowres, bad anatomy, bad hands, bad feet, extra digits, fewer digits, missing fingers',
          noiseSchedule: 'karras',
          characterPrompts: [],
          useCoords: false,
          legacyPromptConditioning: false,
          varietyPlus: false,
          deliberateEulerAncestralBug: false,
          name: 'default',
          profile: '',
          backend: { type: 'NAI' },
        },
      ],
    },
    inpaints: {},
    scenes,
    library: {},
    presetShareds: {
      SDImageGenEasy: {
        type: 'SDImageGenEasy',
        vibes: [],
        normalizeStrength: true,
        seed: null,
        characterReferences: [],
        characterPrompt: '',
        backgroundPrompt: '',
        uc: '',
        characterPrompts: [],
      },
      AugmentGen: {
        type: 'AugmentGen',
        image: '',
        weaken: 5,
        method: 'emotion',
      },
      SDImageGen: {
        type: 'SDImageGen',
        vibes: [],
        normalizeStrength: true,
        characterReferences: [],
      },
    },
    characterPresets: {},
    mirrorImage: '',
    mirrorMode: 'blank',
  } as any;
}

export interface CharacterPrompt<T = string> {
  id: string;
  prompt: T;
  uc: string;
  position: CharacterPosition;
  enabled?: boolean;
  fromPreset?: string;
  /** 직접입력·적용 프리셋 배열을 건드리지 않고 최종 캐릭터 순서만 정한다. */
  order?: number;
}

export interface CharacterPosition {
  x: number;
  y: number;
}

export interface IReferenceItem {
  path: string;
  info: number;
  strength: number;
  fidelity: number;
  referenceType: 'character' | 'style' | 'character&style';
  enabled?: boolean;
  fromPreset?: string;
}

// 캐릭터 프리셋 인터페이스 - 캐릭터 프롬프트 + 배경 프롬프트 + 바이브 트랜스퍼/캐릭터 레퍼런스를 하나로 묶음
export interface ICharacterPreset {
  name: string;
  characterPrompt: string; // 캐릭터 프롬프트
  characterUC: string; // 캐릭터 네거티브 프롬프트
  backgroundPrompt: string; // 배경 프롬프트
  vibes: IVibeItem[]; // 바이브 트랜스퍼
  characterReferences: IReferenceItem[]; // 캐릭터 레퍼런스
  // 파일명 옵션 (옵셔널 - 하위 호환성 유지)
  filenamePrefix?: string; // 다운로드 시 파일명 접두사
  filenameSuffix?: string; // 다운로드 시 파일명 접미사
  // 대표 이미지 (옵셔널 - vibes 디렉토리 내 파일명)
  representativeImage?: string;
  // 글로벌 프리셋 유래 추적 (옵셔널 - 하위 호환): instantiateIntoSession 이 기록.
  // 같은 글로벌을 반복 적용해도 로컬 사본을 재사용/갱신해 증식을 막는다.
  fromGlobalId?: string; // 유래 글로벌 엔트리 id
  fromGlobalRev?: number; // 불러온 시점의 글로벌 updatedAt (무변경이면 재복사 생략)
}
