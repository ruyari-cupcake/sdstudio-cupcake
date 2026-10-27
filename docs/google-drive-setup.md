# Google 드라이브 연결

공개판과 비공개판 모두 **환경설정 → 드라이브**에서 Google 계정을 연결합니다. 파일을 올리거나 받는 동작은 사용자가 직접 실행하며, 자동 동기화는 아닙니다.

Google에 등록하는 **앱 설정**과 사용자가 나중에 승인하는 **계정 연결**은 서로 다릅니다. 앱 설정만 있다고 개인 Google 계정이나 드라이브 파일에 접근할 수 있는 것은 아닙니다.

## Windows에서 연결하기

1. **환경설정 → 드라이브**를 엽니다.
2. **Google 계정 연결** 버튼을 누를 수 있으면 바로 연결하고, 열린 브라우저에서 계정과 접근 권한을 승인합니다.
3. **앱 설정 필요**가 보이면 **Google 앱 설정 불러오기**를 누릅니다. Google Cloud에서 내려받은 **데스크톱 앱 OAuth JSON**을 선택합니다.
4. 저장이 완료되면 **Google 계정 연결** 버튼이 활성화됩니다. 브라우저에서 승인하면 앱에 연결 상태가 나타납니다.

앱 설정은 한 번 저장하면 다시 실행해도 유지됩니다. 파일 선택을 취소하면 아무것도 바뀌지 않습니다. 설정을 바꾸려면 연결된 계정을 먼저 **연결 해제**합니다.

### 데스크톱 OAuth JSON 만들기

배포자가 앱 설정을 제공하지 않는 빌드에서는 Google Cloud에서 앱을 한 번 등록합니다.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 사용할 프로젝트를 선택하거나 만듭니다.
2. **API 및 서비스 → 라이브러리**에서 **Google Drive API**를 찾아 사용 설정합니다.
3. **Google 인증 플랫폼**에서 앱 이름, 지원 이메일, 대상 등을 설정합니다. 앱이 테스트 상태라면 사용할 Google 계정을 테스트 사용자로 등록합니다.
4. 필요한 데이터 접근 범위에 `https://www.googleapis.com/auth/drive.file`을 지정합니다.
5. **클라이언트 → 클라이언트 만들기**에서 애플리케이션 유형을 **데스크톱 앱**으로 선택합니다.
6. 만들어진 클라이언트의 JSON을 내려받아 SDStudio의 **Google 앱 설정 불러오기**에서 선택합니다.

웹 애플리케이션용 JSON, 서비스 계정 키, 개인 계정의 토큰 파일은 이 입력에서 받지 않습니다. 앱은 JSON에서 데스크톱 클라이언트 ID와 클라이언트 시크릿만 사용하며, 인증·토큰 서버 주소와 브라우저 회신 주소는 앱이 정한 Google/로컬 주소를 사용합니다.

Google의 등록 화면이나 앱 상태에 따라 추가 안내가 표시될 수 있습니다. 앱이 Google Cloud에서 차단되었거나 테스트 사용자가 등록되지 않은 경우에는 앱 등록을 관리하는 계정에서 해당 설정을 완료해야 합니다.

## Android에서 연결하기

Android는 **Google Play 서비스**의 계정 선택·승인 화면을 사용합니다. 데스크톱 OAuth JSON은 사용하지 않습니다.

배포자는 Google Cloud의 Android OAuth 클라이언트에 앱의 **패키지 이름과 서명 인증서 SHA-1 지문**을 등록해야 합니다. 두 배포판의 패키지 이름은 다음과 같습니다.

| 배포판 | 패키지 이름 |
| --- | --- |
| 비공개판 | `io.ruyari.cupcake.sdstudio` |
| 공개판 | `io.ruyari.cupcake.sdstudio.public` |

두 앱이 같은 서명 키를 사용해도 패키지 이름이 다르므로 각각 등록해야 합니다. 이 등록은 소스 코드를 빌드하거나 설치 파일을 배포하는 것과 별도입니다. **서명이 Google 프로젝트에 등록되어 있지 않다**는 오류가 나오면 배포자가 Google Cloud 등록을 확인해야 합니다. 기존 서명 키를 바꾸는 방식으로 해결하지 않습니다.

Google Play 서비스가 없는 기기는 Android의 이 연결 방식을 사용할 수 없습니다. 기존 파일 내보내기·불러오기는 사용할 수 있습니다.

## 보관되는 정보

데스크톱 앱 설정은 PC의 앱 환경설정 폴더에 `google-drive-client.json`으로 저장합니다. 프로젝트·이미지 저장 폴더, 프로젝트 내보내기, 공개 소스에 포함하지 않습니다. 가져온 JSON의 다른 항목과 개인 계정 토큰은 이 파일에 복사하지 않습니다.

계정 연결 뒤의 인증 토큰은 기존 방식대로 별도 파일에 암호화하여 저장합니다. 암호화 저장소가 없는 환경에서는 앱이 실행되는 동안만 계정 연결을 유지하며 화면에서 안내합니다. Android에서는 Google Play 서비스가 인증을 관리합니다.

## 직접 빌드하는 경우

공개/비공개 채널에 관계없이 다음 빌드 환경 변수로 데스크톱 앱 OAuth 클라이언트를 지정할 수 있습니다.

- `SDSTUDIO_GOOGLE_CLIENT_ID`
- `SDSTUDIO_GOOGLE_CLIENT_SECRET`

Windows GitHub Actions는 해당 저장소의 같은 이름 Secrets를 참조합니다. 두 값이 없는 빌드도 설치 후 **Google 앱 설정 불러오기**로 구성할 수 있습니다. 개인 계정 토큰, 기존 설정 파일 또는 서명 키를 소스에 넣지 않습니다. 공개판과 비공개판의 업데이트 저장소 분리는 그대로 유지합니다.

## 공식 자료

- [데스크톱 앱 OAuth와 브라우저·로컬 회신 방식](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Cloud의 데스크톱·Android 클라이언트 만들기](https://developers.google.com/workspace/guides/create-credentials)
- [Google Drive 접근 범위](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
