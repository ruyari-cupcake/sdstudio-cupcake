// 설정 파일/저장 경로 부팅 가드 창 — 모바일 저장소 준비 실패, config.json 을 읽지
// 못했거나 지정 저장 폴더 접근이 불가하면 저장소 부팅을 막고 복구만 허용한다.
// 경로 변경 후에는 새 위치로 재시작할 때까지 추가 작업을 차단한다.
//
// 배경: 조용히 기본 위치로 부팅하면 프로젝트 목록이 비어 보여 "프로젝트가 전부
// 초기화되었다"로 오해되기 쉽다(사후 다이얼로그는 게이트/다른 창에 가려짐).
// 2026-07-25 사용자 결정으로 전면 게이트로 격상.
//
// 색은 전부 --c-* 토큰, 버튼은 back-* 캡슐 클래스만 사용(MigrationGate 와 동일 —
// 다크·화이트 양 테마 가독성, specGuard).

import { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { appState } from '../models/AppService';
import { backend } from '../models';
import { GateShell } from './MigrationGate';
import { changeStorageLocation } from '../models/storageLocationChange';

const SaveLocationGate = observer(() => {
  const fb = appState.saveLocationFallback;
  const configFailure = appState.configLoadFailure;
  const storageFailure = appState.storageBootFailure;
  const [restarting, setRestarting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const changing = appState.storageLocationChange;
  if (changing) {
    return (
      <GateShell>
        <div className="text-lg font-semibold">저장 위치를 적용하는 중</div>
        <div className="text-sm text-sub whitespace-pre-line">
          {changing.phase === 'saving'
            ? '현재 위치의 편집 내용을 저장하고 있습니다.'
            : '새 위치는 앱을 다시 시작한 뒤 사용합니다. 다시 시작할 때까지 새 작업은 시작하지 않습니다.'}
          {`\n\n선택한 위치: ${changing.path}`}
        </div>
        {changing.error && (
          <>
            <div className="text-sm text-red-500 dark:text-red-400">
              {changing.error}
            </div>
            <button
              type="button"
              className="w-full px-4 py-2 rounded back-sky clickable"
              onClick={async () => {
                appState.storageLocationChange = {
                  ...changing,
                  error: undefined,
                };
                try {
                  await backend.restartApp();
                } catch (error) {
                  appState.storageLocationChange = {
                    ...changing,
                    error:
                      error instanceof Error ? error.message : String(error),
                  };
                }
              }}
            >
              앱 다시 시작하여 적용
            </button>
          </>
        )}
      </GateShell>
    );
  }
  if (storageFailure !== null) {
    return (
      <GateShell>
        <div className="text-lg font-semibold text-red-500 dark:text-red-400">
          저장소를 준비할 수 없습니다
        </div>
        <div className="text-sm text-sub whitespace-pre-line leading-relaxed">
          {`저장소 접근 또는 기존 설정 읽기에 실패해 시작을 중단했습니다. 저장소 권한과 파일 상태를 확인한 뒤 다시 시도해주세요.\n\n오류: ${storageFailure}`}
        </div>
        {recoveryError && (
          <div className="text-sm text-red-500 dark:text-red-400 whitespace-pre-line">
            {recoveryError}
          </div>
        )}
        <button
          type="button"
          className="w-full px-4 py-2 rounded back-sky clickable"
          disabled={restarting}
          onClick={async () => {
            setRestarting(true);
            setRecoveryError('');
            try {
              await backend.restartApp();
            } catch (e) {
              console.error('저장소 준비 실패 후 앱 재시작 실패:', e);
              setRecoveryError(
                '앱을 다시 시작하지 못했습니다. 다시 시도해주세요.',
              );
              setRestarting(false);
            }
          }}
        >
          {restarting ? '다시 시작하는 중…' : '앱 다시 시작하여 재시도'}
        </button>
      </GateShell>
    );
  }
  if (configFailure) {
    return (
      <GateShell>
        <div className="text-lg font-semibold text-red-500 dark:text-red-400">
          설정 파일을 읽을 수 없습니다
        </div>
        <div className="text-sm text-sub whitespace-pre-line leading-relaxed">
          {`저장 경로가 기록된 설정 파일을 읽지 못해 부팅을 중단했습니다. 잘못된 기본 위치로 계속 실행하면 프로젝트가 모두 사라진 것처럼 보일 수 있습니다.\n\n` +
            `설정 파일: ${configFailure.path}\n` +
            `오류: ${configFailure.code}\n\n` +
            `파일을 사용 중인 프로그램·백신·동기화 작업을 종료한 뒤 다시 시도해주세요. 같은 문제가 반복되면 설정 파일이 손상되었을 수 있으므로 삭제하거나 덮어쓰지 말고 별도로 보관해주세요. 기존 프로젝트 파일은 수정되지 않았습니다.`}
        </div>
        {recoveryError && (
          <div className="text-sm text-red-500 dark:text-red-400 whitespace-pre-line">
            {recoveryError}
          </div>
        )}
        {!resetConfirm ? (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="w-full px-4 py-2 rounded back-sky clickable"
              disabled={restarting}
              onClick={async () => {
                setRestarting(true);
                try {
                  await backend.restartApp();
                } catch (e) {
                  console.error('앱 재시작 실패:', e);
                  setRestarting(false);
                }
              }}
            >
              {restarting ? '다시 시작하는 중…' : '앱 다시 시작하여 재시도'}
            </button>
            <button
              type="button"
              className="w-full px-4 py-2 rounded back-gray clickable"
              disabled={restarting}
              onClick={() => setResetConfirm(true)}
            >
              반복 실패 시 설정 복구
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-sm text-sub whitespace-pre-line">
              설정 파일을 별도 백업명으로 보존한 뒤 기본 설정으로 다시
              시작합니다. 프로젝트 파일은 건드리지 않지만, 사용자 지정 저장
              위치와 앱 설정은 환경설정에서 다시 지정해야 합니다.
            </div>
            <button
              type="button"
              className="w-full px-4 py-2 rounded back-orange clickable"
              disabled={restarting}
              onClick={async () => {
                setRestarting(true);
                setRecoveryError('');
                try {
                  const backupPath = await backend.backupFailedConfig();
                  console.warn(
                    '손상된 설정을 복구용으로 백업했습니다:',
                    backupPath,
                  );
                  await backend.restartApp();
                } catch (e: any) {
                  console.error('설정 파일 복구 실패:', e);
                  setRecoveryError(
                    `설정 파일을 백업하지 못했습니다. 파일 권한이나 잠금을 확인해주세요.\n(${String(
                      e?.message || e,
                    )})`,
                  );
                  setRestarting(false);
                }
              }}
            >
              {restarting ? '설정을 백업하는 중…' : '설정 파일 백업 후 초기화'}
            </button>
            <button
              type="button"
              className="w-full px-4 py-2 rounded back-gray clickable"
              disabled={restarting}
              onClick={() => setResetConfirm(false)}
            >
              돌아가기
            </button>
          </div>
        )}
      </GateShell>
    );
  }
  if (!fb) return null;
  return (
    <GateShell>
      <div className="text-lg font-semibold text-red-500 dark:text-red-400">
        저장 폴더에 접근할 수 없습니다
      </div>
      <div className="text-sm text-sub whitespace-pre-line leading-relaxed">
        {`지정한 저장 위치에 접근할 수 없어 저장소 시작을 중단했습니다. (${fb.code})\n\n` +
          `지정 위치: ${fb.attempted}\n\n` +
          '다른 위치로 바꾸거나 기본 폴더에 새 프로젝트를 저장하지 않았습니다. 드라이브 연결·권한을 확인한 뒤 다시 시작하거나 다른 저장 폴더를 선택해주세요. 기존 파일은 자동으로 옮기거나 삭제하지 않습니다.'}
      </div>
      {recoveryError && (
        <div className="text-sm text-red-500 dark:text-red-400 whitespace-pre-line">
          {recoveryError}
        </div>
      )}
      <div className="flex flex-col gap-2 mt-1">
        <button
          type="button"
          className="w-full px-4 py-2 rounded back-sky clickable"
          disabled={restarting}
          onClick={async () => {
            setRestarting(true);
            setRecoveryError('');
            try {
              await backend.restartApp();
            } catch (error) {
              setRecoveryError(
                error instanceof Error ? error.message : String(error),
              );
              setRestarting(false);
            }
          }}
        >
          {restarting ? '다시 시작하는 중…' : '앱 다시 시작하여 재시도'}
        </button>
        <button
          type="button"
          className="w-full px-4 py-2 rounded back-gray clickable"
          disabled={restarting}
          onClick={async () => {
            setRestarting(true);
            setRecoveryError('');
            try {
              const folder = await backend.selectDir();
              if (!folder) {
                setRestarting(false);
                return;
              }
              // No stores were loaded in a blocked boot, so recovery must not
              // flush their empty defaults over the existing user data.
              await changeStorageLocation(folder, {
                assertIdle: () => undefined,
                flush: async () => undefined,
                commit: (target) => backend.changeSaveLocation(target),
                restart: () => backend.restartApp(),
                setState: (state) => {
                  appState.storageLocationChange = state;
                },
              });
            } catch (error) {
              setRecoveryError(
                error instanceof Error ? error.message : String(error),
              );
              setRestarting(false);
            }
          }}
        >
          다른 저장 위치 선택
        </button>
      </div>
    </GateShell>
  );
});

export default SaveLocationGate;
