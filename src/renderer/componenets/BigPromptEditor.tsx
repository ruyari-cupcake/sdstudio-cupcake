import { type ReactNode, useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { FaPlay, FaStar, FaStop } from 'react-icons/fa';
import { imageService, isMobile, taskQueueService } from '../models';
import { appState } from '../models/AppService';
import { isValidNaiSeed, MAX_NAI_SEED } from '../models/sceneSeedGroups';
import { KBD_CHIP_RESERVE_PX } from './MobileKeyboardChip';
import { FloatView } from './FloatView';
import PromptEditTextArea from './PromptEditTextArea';
import { TaskProgressBar } from './TaskQueueControl';
import Tooltip from './Tooltip';

/**
 * 씬 전용 시드 입력(2026-09-26). 비우면 미설정(→ 그룹 시드 → 프롬프트 시드 → 랜덤). blur/Enter 에 저장, 범위 밖이면
 * 알림 뒤 이전 값으로 되돌린다(시드 그룹 배지 입력과 같은 규칙). 값은 Scene.sceneSeed(직렬화 포함).
 */
function SceneSeedInput({
  value,
  onChange,
  disabled,
}: {
  value: number | undefined;
  onChange: (seed: number | undefined) => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setText(value === undefined ? '' : String(value));
  }, [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === '') {
      if (value !== undefined) onChange(undefined);
      return;
    }
    const seed = Number(trimmed);
    if (!isValidNaiSeed(seed)) {
      appState.pushMessage(`시드는 0~${MAX_NAI_SEED} 사이의 정수여야 합니다.`);
      setText(value === undefined ? '' : String(value));
      return;
    }
    if (seed !== value) onChange(seed);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      data-scene-seed-input=""
      className="gray-input flex-1 min-w-0 h-8 text-sm"
      disabled={disabled}
      value={text}
      placeholder="비우면 그룹 시드 → 프롬프트 시드 → 랜덤"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

interface BigPromptEditorProps {
  presetEditor: ReactNode;
  general: boolean;
  getMiddlePrompt: () => string;
  setMiddlePrompt: (txt: string) => void;
  queuePrompt: (middle: string, callback: (path: string) => void) => void;
  setMainImage?: (path: string) => void;
  initialImagePath?: string;
  // 단순 씬 에디터 모드: 프리셋 폼 대신 중간 프롬프트 + 씬 전용 네거티브 두 입력만 노출
  simplified?: boolean;
  getSceneUC?: () => string;
  setSceneUC?: (txt: string) => void;
  /** 모바일 집중 모드(키보드가 떠 편집 중): 이미지·즐겨찾기·진행 막대 영역을 숨기고 편집기가 높이를 전부 쓴다(2026-09-26). */
  keyboardCompact?: boolean;
  /** 씬 전용 시드(단순 씬 에디터 전용, 2026-09-26). onSceneSeedChange 가 있을 때만 줄을 그린다. */
  sceneSeed?: number;
  onSceneSeedChange?: (seed: number | undefined) => void;
}

export const BigPromptEditor = observer(
  ({
    general,
    presetEditor,
    getMiddlePrompt,
    setMiddlePrompt,
    initialImagePath,
    queuePrompt,
    setMainImage,
    simplified,
    getSceneUC,
    setSceneUC,
    keyboardCompact,
    sceneSeed,
    onSceneSeedChange,
  }: BigPromptEditorProps) => {
    const [image, setImage] = useState<string | undefined>(undefined);
    const [previewError, setPreviewError] = useState<string | undefined>();
    const [path, setPath] = useState<string | undefined>(initialImagePath);
    const [, rerender] = useState<{}>({});
    useEffect(() => {
      let active = true;
      setImage(undefined);
      setPreviewError(undefined);
      const load = async () => {
        try {
          if (!path) return;
          const dataUri = await imageService.fetchImage(path);
          if (active) setImage(dataUri ?? undefined);
        } catch (error) {
          if (active)
            setPreviewError(
              `이미지 미리보기를 불러오지 못했습니다: ${String(error)}`,
            );
        }
      };
      void load();
      return () => {
        active = false;
      };
    }, [path]);
    useEffect(() => {
      const handleProgress = () => {
        rerender({});
      };
      taskQueueService.addEventListener('start', handleProgress);
      taskQueueService.addEventListener('stop', handleProgress);
      taskQueueService.addEventListener('progress', handleProgress);
      return () => {
        taskQueueService.removeEventListener('start', handleProgress);
        taskQueueService.removeEventListener('stop', handleProgress);
        taskQueueService.removeEventListener('progress', handleProgress);
      };
    }, []);

    const [promptOpen, setPromptOpen] = useState(false);

    return (
      <div className="flex h-full flex-col md:flex-row">
        {!simplified && promptOpen && (
          <FloatView
            key="float"
            priority={0}
            onEscape={() => {
              setPromptOpen(false);
            }}
          >
            {presetEditor}
          </FloatView>
        )}
        {simplified ? (
          <div
            className={
              keyboardCompact
                ? 'overflow-auto flex-1 min-h-0 md:h-auto md:w-1/3 md:h-full'
                : 'overflow-auto flex-none h-1/3 md:h-auto md:w-1/3 md:h-full'
            }
            // 집중 모드에서는 키보드 위 칩이 마지막 줄을 가리지 않게 아래를 비워 둔다(2026-09-27)
            style={
              keyboardCompact
                ? { paddingBottom: KBD_CHIP_RESERVE_PX }
                : undefined
            }
            data-scene-prompt-column={keyboardCompact ? 'compact' : undefined}
          >
            <div className="h-full flex flex-col p-2 gap-2 overflow-hidden">
              <div className="flex-none font-bold text-sub">
                중간 프롬프트 (이 씬에만 적용됨)
              </div>
              <div className="flex-[2] min-h-0 overflow-hidden">
                <PromptEditTextArea
                  onChange={setMiddlePrompt}
                  value={getMiddlePrompt()}
                />
              </div>
              <div className="flex-none font-bold text-sub">
                씬 전용 네거티브 프롬프트 (이 씬에만 적용됨)
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                <PromptEditTextArea
                  onChange={(text) => setSceneUC?.(text)}
                  value={getSceneUC ? getSceneUC() : ''}
                />
              </div>
              {onSceneSeedChange && (
                // 씬 전용 시드(2026-09-26): 우선순위 씬 전용 → 그룹 → 프롬프트 → 랜덤(resolveSceneSeed)
                <div
                  className="flex-none flex items-center gap-2"
                  data-scene-seed-row=""
                >
                  <span className="font-bold text-sub text-sm flex-none">
                    씬 전용 시드
                  </span>
                  <SceneSeedInput
                    value={sceneSeed}
                    onChange={onSceneSeedChange}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="overflow-auto flex-none h-1/3 md:h-auto md:w-1/3 md:h-full">
            <div className="hidden md:block h-full ">{presetEditor}</div>
            <div className="h-full flex flex-col p-2 overflow-hidden block md:hidden">
              <div className="flex-none font-bold text-sub">
                중위 프롬프트 (이 씬에만 적용됨):
              </div>
              <div className="flex-1 p-2 overflow-hidden">
                <PromptEditTextArea
                  onChange={setMiddlePrompt}
                  value={getMiddlePrompt()}
                />
              </div>
              <div className="flex-none">
                <button
                  type="button"
                  className="round-button back-sky"
                  onClick={() => setPromptOpen(true)}
                >
                  상세설정
                </button>
              </div>
            </div>
          </div>
        )}
        <div
          className={
            keyboardCompact
              ? 'hidden md:block flex-none h-2/3 md:h-auto md:w-2/3 overflow-hidden'
              : 'flex-none h-2/3 md:h-auto md:w-2/3 overflow-hidden'
          }
        >
          <div className="flex flex-col h-full">
            <div className="flex-1 overflow-hidden">
              {previewError && (
                <p role="status" className="p-2 text-red-400">
                  {previewError}
                </p>
              )}
              {image && (
                <img
                  alt="씬 이미지 미리보기"
                  className="w-full h-full object-contain"
                  src={image}
                  draggable={false}
                />
              )}
            </div>
            <div className="ml-auto flex-none flex gap-4 pt-2 mb-2 md:mb-0">
              {path && (
                <button
                  type="button"
                  className="round-button back-orange h-8 md:w-36 flex items-center justify-center"
                  onClick={() => {
                    setMainImage?.(path);
                  }}
                >
                  {general ? (
                    !isMobile ? (
                      '즐겨찾기 지정'
                    ) : (
                      <FaStar />
                    )
                  ) : (
                    '프로필 지정'
                  )}
                </button>
              )}
              <TaskProgressBar fast />
              {!taskQueueService.isRunning() ? (
                <Tooltip content="생성">
                  <button
                    type="button"
                    className="round-button back-green h-8 w-16 md:w-36 flex items-center justify-center"
                    onClick={() => {
                      queuePrompt(
                        getMiddlePrompt(),
                        (generatedPath: string) => {
                          setPath(generatedPath);
                        },
                      );
                    }}
                  >
                    <FaPlay size={15} />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content="중지">
                  <button
                    type="button"
                    className="round-button back-red h-8 w-16 md:w-36 flex items-center justify-center"
                    onClick={() => {
                      taskQueueService.removeAllTasks();
                      taskQueueService.stop();
                    }}
                  >
                    <FaStop size={15} />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);
