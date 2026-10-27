# Cupcake 포크의 변경 내용

## 6.1.1-cupcake.1

- 예전 감정·포즈 프로젝트 JSON을 현재 씬 템플릿 관리 화면에서 바로 불러올 수 있습니다. [가져오기 안내](legacy-assets-guide.md)
- 씬을 복사할 때 필요한 프롬프트 조각과 전역 조각 참조도 함께 보존합니다. 이름이 충돌하면 가져온 쪽에 새 이름을 붙이고 참조를 맞춥니다.
- 씬 설정을 가져올 때 시드·네거티브·캐릭터·워크플로 설정을 반영하며, 기존 생성 이미지와 선택은 유지합니다.
- 운영체제가 JSON 형식을 알려주지 않거나 확장자가 대문자인 파일도 처리합니다. 맞지 않는 종류의 파일은 해당 가져오기 경로를 안내합니다.
- 저장 실패를 완료로 안내하던 경로와, 읽기 전용·다른 창 소유 프로젝트 및 열지 않은 동명 프로젝트에 가져오던 경로를 보완했습니다.
- 씬만 옮길 때 불필요한 프리셋 이미지 복제를 피합니다.
- 공개판에서 Google 앱 설정을 강제로 제외하던 처리를 제거했습니다. 설정이 포함되지 않은 PC 빌드는 환경설정의 **Google 앱 설정 불러오기**로 구성할 수 있습니다. [Google 드라이브 설정](google-drive-setup.md)
- Google 앱 설정은 개인 계정 토큰과 분리하여 저장하고 다시 실행해도 유지합니다. 실제 Google 계정 연결에는 유효한 앱 등록이 필요합니다. Android는 각 패키지·서명의 Google Cloud 등록을 사용합니다.

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
