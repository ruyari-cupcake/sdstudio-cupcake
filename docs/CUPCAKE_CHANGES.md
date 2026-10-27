# Cupcake 포크의 변경 내용

## 6.1.0-cupcake.1

- 프로그램을 시작할 때 새 릴리즈가 있는지 확인합니다.
- 새 버전이 있으면 업데이트 여부를 묻고, 일주일 동안 알림을 숨길 수 있습니다.
- 공개 버전은 공개 릴리즈만 받습니다. 프로그램 이름과 설치 ID도 별도로 사용합니다.
- Windows 단일 실행파일과 폴더 배포, Android APK에 맞춰 업데이트를 처리합니다.
- 다운로드한 파일의 크기와 SHA-256을 확인합니다.
- Windows 폴더 업데이트는 배포 파일 목록을 기준으로 교체하며, 사용자가 추가한 파일은 보존합니다.
- 빌드 메타데이터와 실제 배포 파일이 같은 버전·같은 채널인지 검사합니다.

업데이트 구현은 `src/shared/appUpdate.ts`, `src/main`의 업데이트 처리, `src/renderer`의 업데이트 화면, Android 네이티브 플러그인, `assets/update-helper.ps1`에서 확인할 수 있습니다. 빌드와 배포 파일 목록 생성은 `.github/workflows`와 `tools`에 있습니다.

## 이전부터 포함된 Cupcake 변경

- 저장 폴더를 직접 고르고 현재 사용하는 위치를 확인할 수 있습니다. [설정 화면](../src/renderer/componenets/ConfigScreen.tsx)
- 저장 위치를 바꿀 때 작업을 먼저 저장하고 다시 시작합니다. [저장 위치 변경](../src/renderer/models/storageLocationChange.ts)
- 선택한 폴더에 접근할 수 없으면 기본 폴더로 자동 변경하지 않고 저장을 멈춥니다. [저장 경로 확인](../src/main/dataStorageGate.ts)
- 장면을 합치다가 실패해도 원래 파일과 기존 파일을 보존하도록 했습니다. [장면 처리](../src/renderer/models/SessionService.ts)
- 이미지 이름을 바꿀 때 파일과 프로젝트의 이미지 참조가 어긋나지 않도록 했습니다. [이미지 처리](../src/renderer/models/ImageService.ts) · [이름 변경 검사](../src/renderer/models/__tests__/sessionImageRenameIntegrity.test.ts)
- 휴지통 복원에서 실패한 항목을 구분해 보여 주고, 기존 파일을 보존하도록 했습니다. [휴지통 처리](../src/renderer/models/TrashService.ts)
- 작가와 휴지통 목록에서는 화면에 보이는 항목의 작은 미리보기를 읽고, 자세히 볼 때 원본을 불러옵니다. [미리보기](../src/renderer/componenets/ImagePreview.tsx)
- 화면을 닫거나 항목이 사라지면 미리보기에 사용한 자원을 정리하고, 불필요한 이미지 감시 알림을 줄였습니다. [미리보기 수명](../src/renderer/componenets/PreviewReadScope.ts) · [이미지 감시](../src/main/imageWatchService.ts)
- 설정창의 버튼과 입력란이 창을 끌어 움직이는 동작에 가로막히지 않도록 고쳤습니다. [설정 화면](../src/renderer/componenets/ConfigScreen.tsx)
- 입력창·설정창·팝업을 사용할 때 뒤쪽 화면의 단축키가 함께 실행되지 않도록 했습니다. [키보드 처리](../src/renderer/models/KeyboardShortcutService.ts)
