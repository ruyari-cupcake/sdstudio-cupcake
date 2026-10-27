import * as React from 'react';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';

import {
  FaPortrait,
  FaTimes,
  FaToggleOff,
  FaToggleOn,
  FaTrash,
} from 'react-icons/fa';
import { ActionIcon } from './ActionIcon';
import { FileUploadBase64 } from './UtilComponents';
import Tooltip from './Tooltip';
import { ReferenceItem } from '../models/types';
import { imageService, isMobile } from '../models';
import { appState } from '../models/AppService';
import {
  type WFIInlineInput,
  wfiElementKey,
} from '../models/workflows/WorkFlow';
import { ModelVersion } from '../backends/imageGen';
import { WFElementContext, PresetIconRowContext } from './wfElementContext';
import {
  EditableSliderValue,
  VibeImage,
  useNarrowContainer,
} from './VibeEditor';
import { resolveCompanionButtons } from '../models/companionSlots';
import { renderCompanionButtons } from './PortableToolbarButtons';
import { CompanionHostRow } from './CompanionDnd';

// PreSetEdtior.tsx 에서 분리된 캐릭터 레퍼런스 편집기 계열.
interface CharacterReferenceEditorProps {
  disabled: boolean;
}

// 레퍼런스 기본값 localStorage 키
const REF_DEFAULT_STRENGTH_KEY = 'sdstudio-ref-default-strength';
const REF_DEFAULT_FIDELITY_KEY = 'sdstudio-ref-default-fidelity';
const REF_DEFAULT_TYPE_KEY = 'sdstudio-ref-default-type';

export function getRefDefaults() {
  const defaults: {
    strength: number;
    fidelity: number;
    referenceType: 'character' | 'style' | 'character&style';
  } = {
    strength: 0.6,
    fidelity: 1.0,
    referenceType: 'character',
  };
  try {
    const strength = Number.parseFloat(
      localStorage.getItem(REF_DEFAULT_STRENGTH_KEY) ?? '',
    );
    const fidelity = Number.parseFloat(
      localStorage.getItem(REF_DEFAULT_FIDELITY_KEY) ?? '',
    );
    const referenceType = localStorage.getItem(REF_DEFAULT_TYPE_KEY);
    if (Number.isFinite(strength)) defaults.strength = strength;
    if (Number.isFinite(fidelity)) defaults.fidelity = fidelity;
    if (
      referenceType === 'character' ||
      referenceType === 'style' ||
      referenceType === 'character&style'
    )
      defaults.referenceType = referenceType;
  } catch (error) {
    // Browser storage is optional; keep the established defaults when unavailable.
    console.warn('레퍼런스 기본값 읽기 실패:', error);
  }
  return defaults;
}

export const CharacterReferenceEditor = observer(
  ({ disabled }: CharacterReferenceEditorProps) => {
    const { curSession } = appState;
    const {
      preset,
      shared,
      editCharacterReference,
      setEditCharacterReference,
      meta,
    } = useContext(WFElementContext)!;
    const [isDragging, setIsDragging] = useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);
    // 패널 폭 적응 — 좁으면 항목을 세로 배치(이미지 위/컨트롤 아래)로 전환
    const narrow = useNarrowContainer(containerRef, editCharacterReference);
    const [showDefaults, setShowDefaults] = useState(false);
    const [refDefaults, setRefDefaults] = useState(getRefDefaults);
    const readersRef = useRef(new Set<FileReader>());
    const readOwnerRef = useRef({ active: true });
    useEffect(() => {
      const owner = { active: !disabled && !!editCharacterReference };
      readOwnerRef.current = owner;
      const readers = readersRef.current;
      return () => {
        owner.active = false;
        readers.forEach((reader) => {
          if (reader.readyState === FileReader.LOADING) reader.abort();
        });
        readers.clear();
      };
    }, [curSession, disabled, editCharacterReference]);
    // shared 필드의 fromPreset 항목 = 캐릭터 프리셋 귀속(개별 삭제 대신 프리셋 단위 해제 — W4)
    const isPresetActive = editCharacterReference?.fieldType === 'shared';

    const updateDefault = (key: string, value: string) => {
      try {
        localStorage.setItem(key, value);
        setRefDefaults(getRefDefaults());
      } catch (error) {
        appState.pushMessage(
          `레퍼런스 기본값 저장 실패: ${String(error)}`,
          'error',
        );
      }
    };

    const getField = useCallback(() => {
      if (editCharacterReference!.fieldType === 'preset')
        return preset[editCharacterReference!.field];
      if (editCharacterReference!.fieldType === 'shared')
        return shared[editCharacterReference!.field];
      return meta![editCharacterReference!.field];
    }, [editCharacterReference, preset, shared, meta]);
    const setField = (val: any) => {
      if (editCharacterReference!.fieldType === 'preset')
        preset[editCharacterReference!.field] = val;
      else if (editCharacterReference!.fieldType === 'shared')
        shared[editCharacterReference!.field] = val;
      else meta![editCharacterReference!.field] = val;
    };
    const referenceChange = useCallback(
      async (reference: string) => {
        if (!reference || !curSession || !editCharacterReference || disabled)
          return;
        const owner = readOwnerRef.current;
        const { field, fieldType } = editCharacterReference;
        const destination =
          fieldType === 'preset'
            ? preset
            : fieldType === 'shared'
              ? shared
              : meta!;
        try {
          const path = await imageService.storeReferenceImage(
            curSession,
            reference,
          );
          const defaults = getRefDefaults();
          // Persistence already began for this owner; publish into its current field.
          // A same-field list replacement is respected, while a new editor cannot retarget it.
          destination[field].push(
            ReferenceItem.fromJSON({
              path,
              info: 1.0,
              strength: defaults.strength,
              fidelity: defaults.fidelity,
              referenceType: defaults.referenceType,
            }),
          );
        } catch (error) {
          if (owner.active)
            appState.pushMessage(
              `레퍼런스 이미지 저장 실패: ${String(error)}`,
              'error',
            );
        }
      },
      [curSession, disabled, editCharacterReference, preset, shared, meta],
    );

    const readReferenceFile = useCallback(
      (file: File) => {
        const owner = readOwnerRef.current;
        if (!owner.active) return;
        const reader = new FileReader();
        const readers = readersRef.current;
        readers.add(reader);
        reader.onload = (event) => {
          readers.delete(reader);
          if (!owner.active) return;
          const base64 = (event.target?.result as string)?.split(',')[1];
          if (base64) void referenceChange(base64);
        };
        reader.onerror = () => {
          readers.delete(reader);
          if (owner.active)
            appState.pushMessage(
              `레퍼런스 파일 읽기 실패: ${reader.error?.message ?? '알 수 없는 오류'}`,
              'error',
            );
        };
        reader.onabort = () => {
          readers.delete(reader);
        };
        try {
          reader.readAsDataURL(file);
        } catch (error) {
          readers.delete(reader);
          if (owner.active)
            appState.pushMessage(
              `레퍼런스 파일 읽기 실패: ${String(error)}`,
              'error',
            );
        }
      },
      [referenceChange],
    );

    useEffect(() => {
      if (!editCharacterReference || disabled) return undefined;
      const handlePaste = (event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              event.preventDefault();
              readReferenceFile(file);
            }
            break;
          }
        }
      };
      window.addEventListener('paste', handlePaste);
      return () => window.removeEventListener('paste', handlePaste);
    }, [editCharacterReference, disabled, readReferenceFile]);

    const handleDragEnter = (event: React.DragEvent) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(true);
    };
    const handleDragLeave = (event: React.DragEvent) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);
    };
    const handleDragOver = handleDragEnter;
    const handleDrop = (event: React.DragEvent) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);
      for (const file of event.dataTransfer.files) {
        if (file.type.startsWith('image/')) readReferenceFile(file);
      }
    };

    return (
      editCharacterReference && (
        <div
          ref={containerRef}
          className={`w-full h-full overflow-hidden flex flex-col ${isDragging ? 'ring-2 ring-sky-500 bg-sky-50 dark:bg-sky-900/20' : ''}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="flex-1 overflow-hidden">
            {/* flex-col: 빈 상태 안내가 "기본값 설정 헤더를 뺀 잔여 높이"(flex-1)를 채우게
              한다 — h-full 이면 헤더 높이만큼 항상 넘쳐 빈 상태에서 세로 스크롤이 생긴다. */}
            <div className="h-full overflow-auto flex flex-col">
              <p className="mx-2 mt-2 text-xs text-muted">
                정밀 레퍼런스는 캐릭터·스타일·둘 다 적용할 수 있습니다.
                Strength·Fidelity 숫자를 누르면 음수도 직접 입력할 수 있습니다.
              </p>
              {/* 기본값 설정 섹션 */}
              <div className="mx-2 mt-2 mb-1">
                <button
                  type="button"
                  className="text-xs text-muted hover:text-gray-700 dark:hover:text-gray-200 flex items-center gap-1"
                  onClick={() => setShowDefaults(!showDefaults)}
                >
                  {showDefaults ? '▾' : '▸'} 새 레퍼런스 기본값 설정
                </button>
                {showDefaults && (
                  <div className="mt-2 p-3 bg-[var(--c-surface)] rounded-lg space-y-3 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="gray-label w-20 flex-none">
                        Strength:
                      </span>
                      <input
                        type="range"
                        className="flex-1 min-w-0"
                        min={Math.min(0, refDefaults.strength)}
                        max={Math.max(2, refDefaults.strength)}
                        step="0.01"
                        value={refDefaults.strength}
                        onChange={(e) =>
                          updateDefault(
                            REF_DEFAULT_STRENGTH_KEY,
                            e.target.value,
                          )
                        }
                      />
                      <EditableSliderValue
                        value={refDefaults.strength}
                        onChange={(value) =>
                          updateDefault(REF_DEFAULT_STRENGTH_KEY, String(value))
                        }
                        disabled={disabled}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="gray-label w-20 flex-none">
                        Fidelity:
                      </span>
                      <input
                        type="range"
                        className="flex-1 min-w-0"
                        min={Math.min(0, refDefaults.fidelity)}
                        max={Math.max(2, refDefaults.fidelity)}
                        step="0.01"
                        value={refDefaults.fidelity}
                        onChange={(e) =>
                          updateDefault(
                            REF_DEFAULT_FIDELITY_KEY,
                            e.target.value,
                          )
                        }
                      />
                      <EditableSliderValue
                        value={refDefaults.fidelity}
                        onChange={(value) =>
                          updateDefault(REF_DEFAULT_FIDELITY_KEY, String(value))
                        }
                        disabled={disabled}
                      />
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="gray-label w-20 flex-none">유형:</span>
                      {(['character', 'style', 'character&style'] as const).map(
                        (t) => (
                          <label
                            key={t}
                            className="flex items-center gap-1 cursor-pointer"
                          >
                            <input
                              type="radio"
                              name="ref-default-type"
                              checked={refDefaults.referenceType === t}
                              onChange={() =>
                                updateDefault(REF_DEFAULT_TYPE_KEY, t)
                              }
                              className="accent-sky-500"
                            />
                            <span className="text-default">{t}</span>
                          </label>
                        ),
                      )}
                    </div>
                  </div>
                )}
              </div>
              {getField().length === 0 && !isMobile && (
                <div className="flex flex-col items-center justify-center flex-1 text-faint p-8">
                  <ActionIcon
                    id="import"
                    size={48}
                    className="mb-4 opacity-60"
                  />
                  <p className="text-base font-medium mb-1">
                    이미지를 드래그하거나
                  </p>
                  <p className="text-base font-medium">
                    Ctrl+V로 붙여넣기 할 수 있습니다
                  </p>
                </div>
              )}
              {getField().map((reference: ReferenceItem) => (
                <div
                  key={reference.path}
                  className={`border mt-2 p-2 flex gap-2 ${narrow ? 'flex-col' : 'items-begin'} ${reference.enabled !== false ? 'border-sky-500 bg-[var(--c-surface-2)]' : 'line-color opacity-60'}`}
                >
                  <VibeImage
                    path={
                      reference.path &&
                      imageService.getReferenceImagePath(
                        curSession!,
                        reference.path,
                      )
                    }
                    className="flex-none w-28 h-28 object-cover"
                  />
                  <div className="flex flex-col gap-2 w-full min-w-0">
                    <div className="flex w-full items-center justify-between gap-1 min-w-0">
                      <div className="flex gap-2 items-center min-w-0">
                        {isPresetActive && reference.fromPreset ? (
                          <Tooltip
                            content={`"${reference.fromPreset}" 프리셋 해제 — 연결된 캐릭터 프롬프트/바이브 함께 제거`}
                          >
                            <button
                              type="button"
                              className="round-button back-gray h-8 px-3 text-xs max-w-full truncate"
                              onClick={() => {
                                if (disabled) return;
                                appState.removeAppliedCharacterPreset(
                                  reference.fromPreset!,
                                );
                              }}
                            >
                              🔒 {reference.fromPreset}
                              <FaTimes className="ml-1.5" size={11} />
                            </button>
                          </Tooltip>
                        ) : (
                          <button
                            type="button"
                            className={`round-button h-8 px-4 ${reference.enabled !== false ? 'back-sky' : 'back-gray'}`}
                            onClick={() => {
                              if (disabled) return;
                              reference.enabled = reference.enabled === false;
                            }}
                            disabled={disabled}
                          >
                            {reference.enabled !== false ? (
                              <FaToggleOn className="mr-1" />
                            ) : (
                              <FaToggleOff className="mr-1" />
                            )}
                            {reference.enabled !== false
                              ? '활성화됨'
                              : '비활성화됨'}
                          </button>
                        )}
                      </div>
                      {!(isPresetActive && reference.fromPreset) && (
                        <Tooltip content="레퍼런스 삭제">
                          <button
                            type="button"
                            className={`round-button icon-only h-8 ${
                              disabled ? 'back-gray' : 'back-red'
                            }`}
                            onClick={() => {
                              if (disabled) return;
                              setField(
                                getField().filter((x: any) => x !== reference),
                              );
                            }}
                          >
                            <FaTrash />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                    <div
                      className={`flex w-full items-center ${narrow ? 'flex-col' : 'md:flex-row flex-col'}`}
                    >
                      <div
                        className={`whitespace-nowrap flex-none gray-label ${narrow ? 'mr-auto' : 'mr-auto md:mr-0'}`}
                      >
                        Strength:
                      </div>
                      <div
                        className={`flex flex-1 gap-1 min-w-0 ${narrow ? 'w-full' : 'md:w-auto w-full'}`}
                      >
                        <input
                          className="flex-1 min-w-0"
                          type="range"
                          step="0.01"
                          min={Math.min(0, reference.strength)}
                          max={Math.max(2, reference.strength)}
                          value={reference.strength}
                          onChange={(e) => {
                            reference.strength = parseFloat(e.target.value);
                          }}
                          disabled={disabled}
                        />
                        <EditableSliderValue
                          value={reference.strength}
                          onChange={(v) => {
                            reference.strength = v;
                          }}
                          disabled={disabled}
                        />
                      </div>
                    </div>
                    <div
                      className={`flex w-full items-center ${narrow ? 'flex-col' : 'md:flex-row flex-col'}`}
                    >
                      <div
                        className={`whitespace-nowrap flex-none gray-label ${narrow ? 'mr-auto' : 'mr-auto md:mr-0'}`}
                      >
                        Fidelity:
                      </div>
                      <div
                        className={`flex flex-1 gap-1 min-w-0 ${narrow ? 'w-full' : 'md:w-auto w-full'}`}
                      >
                        <input
                          className="flex-1 min-w-0"
                          type="range"
                          step="0.01"
                          min={Math.min(0, reference.fidelity)}
                          max={Math.max(2, reference.fidelity)}
                          value={reference.fidelity}
                          onChange={(e) => {
                            reference.fidelity = parseFloat(e.target.value);
                          }}
                          disabled={disabled}
                        />
                        <EditableSliderValue
                          value={reference.fidelity}
                          onChange={(v) => {
                            reference.fidelity = v;
                          }}
                          disabled={disabled}
                        />
                      </div>
                    </div>
                    <div className="flex w-full md:flex-row flex-col items-center mt-2">
                      <div className="flex gap-4 items-center flex-wrap">
                        <label className="flex gap-1 items-center cursor-pointer">
                          <input
                            type="radio"
                            name={`refType-${reference.path}`}
                            checked={reference.referenceType === 'character'}
                            onChange={() => {
                              reference.referenceType = 'character';
                            }}
                            disabled={disabled}
                          />
                          <span className="gray-label">캐릭터</span>
                        </label>
                        <label className="flex gap-1 items-center cursor-pointer">
                          <input
                            type="radio"
                            name={`refType-${reference.path}`}
                            checked={reference.referenceType === 'style'}
                            onChange={() => {
                              reference.referenceType = 'style';
                            }}
                            disabled={disabled}
                          />
                          <span className="gray-label">스타일</span>
                        </label>
                        <label className="flex gap-1 items-center cursor-pointer">
                          <input
                            type="radio"
                            name={`refType-${reference.path}`}
                            checked={
                              reference.referenceType === 'character&style'
                            }
                            onChange={() => {
                              reference.referenceType = 'character&style';
                            }}
                            disabled={disabled}
                          />
                          <span className="gray-label">캐릭터+스타일</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex-none mt-auto pt-2 flex flex-col gap-2">
            {getField().length > 0 && !isMobile && (
              <div className="text-xs text-muted text-center">
                이미지를 드래그하거나 Ctrl+V로 붙여넣기 할 수 있습니다
              </div>
            )}
            <div className="flex gap-2 items-center">
              <FileUploadBase64
                notext
                disabled={disabled}
                onFileSelect={referenceChange}
              />
              <button
                type="button"
                className="round-button back-gray h-8 w-full"
                onClick={() => {
                  setEditCharacterReference(undefined);
                }}
              >
                캐릭터 레퍼런스 설정 닫기
              </button>
            </div>
          </div>
        </div>
      )
    );
  },
);

export const CharacterReferenceButton = observer(
  ({ input }: { input: WFIInlineInput }) => {
    const {
      editCharacterReference,
      setEditCharacterReference,
      preset,
      shared,
      meta,
      modelVersion,
    } = useContext(WFElementContext)!;
    const iconRow = useContext(PresetIconRowContext);
    const [activeIndex, setActiveIndex] = useState(0);

    const getField = () => {
      if (input.fieldType === 'preset') return preset[input.field] || [];
      if (input.fieldType === 'shared') return shared[input.field] || [];
      return meta![input.field] || [];
    };

    // v4 모델은 캐릭터 레퍼런스 미지원
    const isV4 =
      modelVersion === ModelVersion.V4 ||
      modelVersion === ModelVersion.V4Curated;
    const isV5 =
      modelVersion === ModelVersion.V5 ||
      modelVersion === ModelVersion.V5Curated;
    const locked = isV4 || isV5;
    const lockedLabel = isV5
      ? '캐릭터 레퍼런스 (V5 미지원)'
      : '캐릭터 레퍼런스 (V4 모델 미지원)';

    const onClick = () => {
      if (locked) return;
      setEditCharacterReference(input);
    };

    const handleImageClick = (e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      if (locked) return;
      const enabledRefs = getField().filter(
        (ref: ReferenceItem) => ref.enabled !== false,
      );
      if (enabledRefs.length > 1) {
        setActiveIndex((prev: number) => (prev + 1) % enabledRefs.length);
      } else {
        onClick();
      }
    };

    const handleOpenEditor = (e: React.MouseEvent) => {
      e.stopPropagation();
      if (locked) return;
      onClick();
    };

    const field = getField();
    const enabledRefs = field.filter(
      (ref: ReferenceItem) => ref.enabled !== false,
    );
    const safeActiveIndex =
      enabledRefs.length > 0
        ? Math.min(activeIndex, enabledRefs.length - 1)
        : 0;

    const currentReference =
      enabledRefs.length > 0 ? enabledRefs[safeActiveIndex] : null;
    const hasValidPath = currentReference && currentReference.path;

    // 동반 슬롯 (E2): 레퍼런스 행(hostKey = wfiElementKey = 인라인 필드 'characterReferences')
    // 옆에 붙일 portable 버튼. 빈 배열이면 슬롯 없음 = 현행 렌더 100% 동일(회귀 기준).
    // hostKey 를 renderCompanionButtons/CompanionHostRow 에 넘겨 편집모드(PC) 드래그(E4)를 붙인다.
    const hostKey = wfiElementKey(input) ?? input.field;
    const companionIds = resolveCompanionButtons(
      hostKey,
      appState.uiCompanionSlots,
    );
    const companions = renderCompanionButtons(companionIds, hostKey);
    const hasCompanions = companions.length > 0;

    // 하단 아이콘 행(uiPresetIconRow) 안 — 아이콘+활성 수 압축 형태. 잠금 의미는 넓은
    // 버튼과 동일(툴팁으로 사유 안내), 동반 버튼은 그대로 이웃.
    if (iconRow) {
      return (
        <CompanionHostRow hostKey={hostKey}>
          <Tooltip content={locked ? lockedLabel : '캐릭터 레퍼런스 설정 열기'}>
            <button
              type="button"
              className={`round-button h-8 flex-1 min-w-0 ${locked ? 'back-llgray opacity-50 cursor-not-allowed' : 'back-gray'}`}
              onClick={onClick}
              disabled={locked}
            >
              <FaPortrait size={14} className="inline-block" />
              {field.length > 0 && (
                <span className="ml-1 text-xs">
                  {enabledRefs.length}/{field.length}
                </span>
              )}
            </button>
          </Tooltip>
          {companions}
        </CompanionHostRow>
      );
    }

    return (
      <CompanionHostRow hostKey={hostKey}>
        {(editCharacterReference === undefined ||
          editCharacterReference === null) &&
          field.length === 0 &&
          (hasCompanions ? (
            <div className="w-full mt-2 md:mt-3 flex gap-1 items-stretch">
              <button
                type="button"
                className={`round-button h-8 flex-1 flex ${locked ? 'back-llgray opacity-50 cursor-not-allowed' : 'back-gray'}`}
                onClick={onClick}
                disabled={locked}
              >
                <div className="flex-1">
                  {locked ? lockedLabel : '캐릭터 레퍼런스 설정 열기'}
                </div>
              </button>
              {companions}
            </div>
          ) : (
            <button
              type="button"
              className={`round-button h-8 w-full flex mt-2 md:mt-3 ${locked ? 'back-llgray opacity-50 cursor-not-allowed' : 'back-gray'}`}
              onClick={onClick}
              disabled={locked}
            >
              <div className="flex-1">
                {locked ? lockedLabel : '캐릭터 레퍼런스 설정 열기'}
              </div>
            </button>
          ))}
        {(editCharacterReference === undefined ||
          editCharacterReference === null) &&
          field.length > 0 && (
            <div
              className={`w-full flex items-center mt-2 md:mt-3${
                locked ? ' opacity-50' : ''
              }`}
            >
              <div className="flex-none mr-2 gray-label">
                레퍼런스 설정:
                {locked ? (
                  <span className="ml-1 text-xs text-red-400">(v4 미지원)</span>
                ) : (
                  <span className="ml-1 text-xs text-sky-500">
                    ({enabledRefs.length}/{field.length} 활성화)
                  </span>
                )}
              </div>
              <div className="flex-1 flex gap-1 items-center">
                {hasValidPath ? (
                  <VibeImage
                    path={imageService.getReferenceImagePath(
                      appState.curSession!,
                      currentReference.path,
                    )}
                    className={`flex-1 h-14 rounded-xl object-cover${
                      locked
                        ? ' grayscale'
                        : ' cursor-pointer hover:brightness-95 active:brightness-90'
                    }`}
                    onClick={handleImageClick}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={locked}
                    className={`flex-1 h-14 rounded-xl bg-[var(--c-surface)] flex items-center justify-center text-muted${
                      locked
                        ? ''
                        : ' cursor-pointer hover:brightness-95 active:brightness-90'
                    }`}
                    onClick={handleImageClick}
                  >
                    {locked
                      ? isV5
                        ? 'V5 모델 미지원'
                        : 'V4 모델 미지원'
                      : enabledRefs.length === 0
                        ? '활성화된 이미지 없음'
                        : '이미지 없음'}
                  </button>
                )}
                {!locked && (
                  <Tooltip content="레퍼런스 편집">
                    <button
                      type="button"
                      className="flex-none px-2 h-14 rounded-lg back-sky text-white text-xs hover:brightness-95 active:brightness-90"
                      onClick={handleOpenEditor}
                    >
                      편집
                    </button>
                  </Tooltip>
                )}
              </div>
              {hasCompanions && (
                <div className="flex-none flex gap-1 items-center ml-1">
                  {companions}
                </div>
              )}
            </div>
          )}
      </CompanionHostRow>
    );
  },
);
