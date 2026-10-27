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

데스크톱 빌드와 네이티브 모듈 준비는 Windows 워크플로의 순서대로 진행해 주세요. 공개 소스에는 배포용 서명 키와 Google 계정 연결용 OAuth 값이 들어 있지 않습니다.

## 라이선스

SDStudio 소스는 [MIT](LICENSE)입니다. 포함된 폰트와 외부 구성요소의 출처 및 라이선스는 [출처 안내](docs/UPSTREAM.md)에 정리했습니다.
