import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { backend, isMobile, sessionService, templateService } from '../models';
import { appState } from '../models/AppService';
import { isWorkspaceLayout } from '../models/storageLayout';
import {
  collectStorageDiagnostics,
  type StorageDiagnosticRow,
  type BrokenStorageEntry,
} from '../models/storageDiagnostics';
import { openStoragePermissionSettings } from '../models/storagePermissionGate';

// 저장소 진단 (모바일 환경설정 → 복구 탭).
//
// "프로젝트/이미지 증발처럼 보임" 근본 조사(2026-07-31,
// plans/android-storage-vanish-investigation.md) 보조 기능. Android 11+ 는
// '모든 파일 접근'이 없으면 이 설치본이 만들지 않은 파일을 오류 없이 숨기므로
// (FUSE), 권한 상태와 "물리 폴더 수 vs 앱이 인식한 파일 수"를 실측 대조해
// 숨김 의심 상태를 사용자에게 진단해 준다. 검사 자체는 읽기 전용이며, 쓰기는
// 미인식 폴더의 [복원/부분 복구] 버튼을 사용자가 눌러 확인했을 때만 일어난다.

const statusIcon = (status: StorageDiagnosticRow['status']) => {
  if (status === 'ok') return '✅';
  if (status === 'warn') return '⚠️';
  if (status === 'error') return '❌';
  return 'ℹ️';
};

export const StorageDiagnosticsSection = observer(() => {
  const [rows, setRows] = useState<StorageDiagnosticRow[]>([]);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [permissionWarn, setPermissionWarn] = useState(false);
  const [fuseWarn, setFuseWarn] = useState(false);
  const [broken, setBroken] = useState<BrokenStorageEntry[]>([]);
  const [repairing, setRepairing] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [canRepair, setCanRepair] = useState(false);
  const scanRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const repairingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanRef.current?.abort();
    };
  }, []);

  const run = async () => {
    if (scanRef.current || repairingRef.current || !mountedRef.current) return;
    const controller = new AbortController();
    scanRef.current = controller;
    setRunning(true);
    try {
      const result = await collectStorageDiagnostics(
        {
          permissionStatus: async () => {
            if (!isMobile) return { required: false, granted: true };
            const { default: ZipPlugin } =
              await import('../backends/zipService');
            return ZipPlugin.storagePermissionStatus({});
          },
          workspace: isWorkspaceLayout(),
          existFile: (path) => backend.existFile(path),
          listFiles: (path) => backend.listFiles(path),
          readFile: (path) => backend.readFile(path),
          getFreeSpace: () => backend.getFreeSpace(),
          listProjects: () => sessionService.list(),
          filterVisibleProjects: (names) =>
            templateService.filterVisibleProjects(names),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setRows(result.rows);
      setPermissionWarn(result.permissionWarn);
      setFuseWarn(result.fuseWarn);
      setIncomplete(result.incomplete);
      setCanRepair(result.canRepair);
      setBroken(result.broken);
      setRan(true);
    } catch (error) {
      if (controller.signal.aborted) return;
      setRows([
        {
          id: 'scan',
          label: '저장소 진단',
          status: 'error',
          detail: `진단 실패: ${String(error)}`,
        },
      ]);
      setPermissionWarn(false);
      setFuseWarn(false);
      setIncomplete(true);
      setCanRepair(false);
      setBroken([]);
      setRan(true);
    } finally {
      if (scanRef.current === controller) scanRef.current = null;
      if (mountedRef.current) setRunning(false);
    }
  };

  // 미인식 폴더 복구 — 사용자가 버튼으로 명시 확인했을 때만 쓰기가 일어난다.
  // .bak 있으면 완전 복원, 없으면 부분 복구(최소 project.json 생성) 후 기존
  // '이미지 복구'(recoverProjectImages)로 씬/이미지를 재구성한다.
  const repair = (b: BrokenStorageEntry) => {
    appState.pushDialog({
      type: 'confirm',
      danger: true,
      text: b.hasBak
        ? `'${b.name}' 프로젝트를 백업본에서 복원할까요?\n마지막 저장 직전 상태로 되돌아갑니다.`
        : `'${b.name}' 프로젝트는 설정 파일이 유실되어 부분 복구만 가능합니다.\n이미지와 씬 구성은 복원되지만, 프롬프트·프리셋 등 설정은 복구되지 않습니다.\n진행할까요?`,
      callback: async () => {
        if (repairingRef.current || scanRef.current || !mountedRef.current)
          return;
        repairingRef.current = true;
        setRepairing(true);
        try {
          // fromBak 은 서비스가 실제 수행한 복구 방식(재검증 결과) — 진단
          // 시점의 hasBak 과 어긋날 수 있어 이후 동작은 반환값을 따른다.
          const res = await sessionService.repairBrokenWorkspaceFolder(b.dir);
          const sess = await sessionService.get(res.name);
          if (!sess) throw new Error('복구한 프로젝트를 불러오지 못했습니다.');
          if (sess) {
            appState.curSession = sess;
            if (res.fromBak) {
              appState.pushDialog({
                type: 'yes-only',
                text: `'${res.name}' 프로젝트를 백업본에서 복원했습니다.\n설정 화면을 닫으면 프로젝트가 표시됩니다.`,
              });
            } else {
              // 부분 복구 — outs/ 스캔으로 이미지를 재연결(결과는 자체 안내).
              await appState.recoverProjectImages();
            }
          }
        } catch (e) {
          appState.pushDialog({
            type: 'yes-only',
            text: `복구에 실패했습니다: ${(e as Error)?.message || e}`,
          });
        } finally {
          repairingRef.current = false;
          if (mountedRef.current) setRepairing(false);
        }
        if (mountedRef.current) await run(); // Recheck only while this diagnostics view owns the result.
      },
    });
  };

  const hasWarn = rows.some((r) => r.status === 'warn' || r.status === 'error');

  return (
    <div>
      <h3 className="block text-sm font-semibold gray-label mb-1">
        저장소 진단
      </h3>
      <p className="text-xs text-muted mb-2">
        프로젝트나 이미지가 갑자기 사라진 것처럼 보일 때 실행해 주세요. 권한
        상태와 데이터 인식 현황을 실측해 원인을 알려줍니다. 검사 자체는 아무것도
        수정하지 않으며, 복구는 발견된 항목의 버튼을 눌러 확인했을 때만
        진행됩니다.
      </p>
      <button
        type="button"
        className="px-4 py-2 rounded-lg btn-solid-sky text-sm font-medium transition-colors disabled:opacity-40"
        disabled={running || repairing}
        onClick={run}
      >
        {running ? '진단 중...' : '진단 실행'}
      </button>
      {ran && (
        <div className="mt-3 flex flex-col gap-1.5">
          {rows.map((r) => (
            <div
              key={r.id}
              className="flex items-start gap-2 px-2.5 py-1.5 rounded-md border line-color text-xs"
            >
              <span className="flex-none">{statusIcon(r.status)}</span>
              <span className="font-medium text-default flex-none">
                {r.label}
              </span>
              <span className="text-muted">{r.detail}</span>
            </div>
          ))}
          {incomplete ? (
            <div
              role="status"
              className="mt-1 px-2.5 py-2 rounded-md text-xs text-amber-600 dark:text-amber-400 border border-amber-400/40"
            >
              ⚠️ 일부 항목을 확인하지 못해 진단을 완료하지 못했습니다. 위 항목의
              오류를 확인한 뒤 다시 실행해 주세요.
            </div>
          ) : hasWarn ? (
            permissionWarn || fuseWarn ? (
              <div className="mt-1 px-2.5 py-2 rounded-md text-xs text-amber-600 dark:text-amber-400 border border-amber-400/40">
                ⚠️ 이상 징후가 있습니다. 파일이 삭제된 것이 아니라 안드로이드
                보안 정책이 기존 파일을 숨기고 있을 가능성이 큽니다. &ldquo;모든
                파일 접근&rdquo;을 허용한 뒤 앱을 완전히 종료하고 다시 실행해
                주세요 — 데이터가 그대로 표시됩니다.
              </div>
            ) : broken.length > 0 ? (
              <div className="mt-1 px-2.5 py-2 rounded-md text-xs text-amber-600 dark:text-amber-400 border border-amber-400/40">
                ⚠️ 앱이 인식하지 못하는 프로젝트 폴더가 발견되었습니다. 아래
                목록에서 복구를 시도할 수 있습니다.
              </div>
            ) : (
              <div className="mt-1 px-2.5 py-2 rounded-md text-xs text-amber-600 dark:text-amber-400 border border-amber-400/40">
                ⚠️ 이상 징후가 있습니다. 진단 항목의 경고 내용을 확인해 주세요.
              </div>
            )
          ) : (
            <div className="mt-1 px-2.5 py-2 rounded-md text-xs text-green-600 dark:text-green-400 border border-green-500/40">
              ✅ 이상 없음 — 권한과 데이터 인식이 정상입니다.
            </div>
          )}
          {permissionWarn && (
            <button
              type="button"
              className="self-start mt-1 px-4 py-2 rounded-lg btn-solid-sky text-sm font-medium"
              onClick={async () => {
                const opened = await openStoragePermissionSettings();
                if (!opened)
                  appState.pushMessage(
                    '모든 파일 접근 설정 화면을 열지 못했습니다. 기기 설정에서 SDStudio의 저장소 권한을 확인해 주세요.',
                    'error',
                  );
              }}
            >
              모든 파일 접근 설정 열기
            </button>
          )}
          {/* 권한/파일 숨김 의심 상태에서는 복구 섹션을 숨긴다 — 숨김 상태에선
              정상 프로젝트가 전부 미인식으로 오판되며, 그 위에 골격을 쓰면
              숨겨진 원본을 해칠 수 있다. 권한 안내가 우선. */}
          {canRepair && broken.length > 0 && (
            <div className="mt-2">
              <h3 className="block text-sm font-semibold gray-label mb-1">
                미인식 프로젝트 복구
              </h3>
              <p className="text-xs text-muted mb-2">
                아래 폴더는 프로젝트 파일(project.json)이 유실되어 앱이 인식하지
                못합니다. 백업본이 있으면 마지막 저장 상태로 복원되고, 없으면
                이미지와 씬 구성만 되살리는 부분 복구를 시도합니다(프롬프트·
                프리셋 등 설정은 복구되지 않습니다).
              </p>
              <div className="flex flex-col gap-1.5">
                {broken.map((b) => (
                  <div
                    key={b.dir}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border line-color text-xs"
                  >
                    <span className="font-medium text-default flex-1 truncate">
                      {b.name}
                    </span>
                    <span className="text-muted flex-none">
                      {b.hasBak
                        ? '백업본 있음'
                        : b.hasImages
                          ? '이미지 있음'
                          : '복구할 데이터 없음'}
                    </span>
                    {(b.hasBak || b.hasImages) && (
                      <button
                        type="button"
                        className="flex-none px-3 py-1 rounded-lg btn-solid-orange text-xs font-medium disabled:opacity-40"
                        disabled={repairing || running}
                        onClick={() => repair(b)}
                      >
                        {b.hasBak ? '복원' : '부분 복구'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
