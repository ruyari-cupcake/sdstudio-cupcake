# SDStudio · Cupcake 포크

SDStudio를 바탕으로 함께 사용하는 기능과 수정 사항을 나누는 공개 포크입니다. 원작은 [sunho/SDStudio](https://github.com/sunho/SDStudio)이며, [Dd154663/SDStudio](https://github.com/Dd154663/SDStudio)의 변경 사항을 이어받았습니다. 원작의 이름과 MIT 라이선스를 유지합니다.

## 내려받기

[최신 릴리즈](https://github.com/ruyari-cupcake/sdstudio-cupcake/releases/latest)에서 사용 중인 기기에 맞는 파일을 받으세요.

| 파일 이름 끝부분 | 사용 방법 |
| --- | --- |
| `Windows-Portable.exe` | 내려받은 파일을 실행합니다. |
| `Windows-folder.zip` | 압축을 풀고 `SDStudio Cupcake.exe`를 실행합니다. |
| `Android.apk` | Android 기기에서 열어 설치합니다. |

처음에는 이 릴리즈를 직접 설치해 주세요. 기존 SDStudio와 따로 설치되며, 기존 작업은 자동으로 옮겨오지 않아요. 필요한 작업은 기존 앱에서 내보낸 뒤 이 앱에서 불러올 수 있어요.

이 공개 버전은 이 저장소의 공개 릴리즈에서만 업데이트를 받습니다. 새 버전이 있으면 프로그램을 시작할 때 알려 드립니다. 바로 업데이트하거나, 나중에 하거나, 일주일 동안 알림을 숨길 수 있습니다.

## 기존 자료와 Google 드라이브

예전 프로젝트·씬·프롬프트 조각 파일은 [자료 불러오기 안내](docs/legacy-assets-guide.md)를 확인해 주세요.

Google 드라이브 백업 기능은 공개판과 비공개판 모두 제공합니다. **환경설정 → 드라이브**에서 연결합니다. 데스크톱 앱 설정이 없는 빌드라면 **Google 앱 설정 불러오기**로 Google Cloud의 데스크톱 OAuth JSON을 한 번 지정한 뒤 **Google 계정 연결**을 누릅니다. Android는 Google Play 서비스와 해당 앱의 패키지·서명 등록을 사용합니다. [설정 방법과 필요한 등록](docs/google-drive-setup.md)을 확인해 주세요.

## 코드 살펴보기

[변경 내용](docs/CUPCAKE_CHANGES.md)과 [출처](docs/UPSTREAM.md)를 함께 확인해 주세요. 필요한 코드는 MIT 라이선스에 따라 가져가 수정하거나 공유할 수 있습니다. 원래 저작권과 라이선스 안내는 함께 남겨 주세요.

## 직접 빌드하기

Node.js 24와 npm을 사용합니다. Android 빌드는 JDK 17과 Android SDK가 필요합니다. 전체 빌드 순서는 [Windows 워크플로](.github/workflows/build-win.yml)와 [Android 워크플로](.github/workflows/build-android.yml)에 있습니다.

```sh
cd externals/capacitor-background-mode
npm ci
npm run build
cd ../..
npm ci --legacy-peer-deps --ignore-scripts
node tools/check-release-metadata.cjs
npm run build:renderer
```

데스크톱 빌드와 네이티브 모듈 준비는 Windows 워크플로의 순서대로 진행해 주세요. 두 채널 모두 빌드 시 Google 앱 설정을 지정하거나 설치 후 OAuth JSON을 불러올 수 있습니다. 공개 소스에는 배포용 서명 키, 개인 계정 토큰, 로컬 앱 설정 파일이 포함되지 않습니다.

## 라이선스

SDStudio 소스는 [MIT](LICENSE)입니다. 포함된 폰트와 외부 구성요소의 출처 및 라이선스는 [출처 안내](docs/UPSTREAM.md)에 정리했습니다.
