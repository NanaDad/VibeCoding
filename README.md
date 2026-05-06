# JP-KO Translator

Electron + React + TypeScript 기반의 일본어 → 한국어 데스크톱 번역기입니다.

이번 정리에서 실제로 반영한 핵심은 아래 5가지입니다.

- mac Apple Silicon 경로에 `distil-large-v3(faster-whisper/ct2)` 기반 로컬 STT 백엔드를 추가하고, 모델 + Python 런타임을 앱 리소스로 묶을 수 있게 정리
- Windows 배포물에 `ffmpeg.exe + whisper.cpp 실행 파일 + ggml-base.bin 모델`을 함께 넣어 별도 STT 설치 없이 바로 실행되게 정리
- 실사용 기본 조합을 `실사용 권장 + 자동 선택`으로 정리
- Provider 카드를 누르면 실제 입력/저장이 되는 설정 모달과 연결 테스트가 뜨도록 변경
- Codex auth 의존을 기본값에서 빼고, API 키 기반 provider가 있으면 자동으로 우선 선택되게 변경

## 실행 방법

### macOS

- `JP-KO Translator.command`

mac Apple Silicon 배포에서는 아래 준비 스크립트로 STT 런타임과 모델을 같이 넣을 수 있습니다.

```bash
npm run prepare:stt:mac
```

이 스크립트는 아래를 준비합니다.

- `vendor/python/darwin/arm64` : faster-whisper 실행용 Python 런타임
- `vendor/models/darwin/arm64/distil-large-v3-ct2` : distil-large-v3 모델

### Windows exe bundle

압축 해제 후 아래 파일을 실행합니다.

- `JP-KO Translator.exe`

이 번들은 Windows에서 아래 STT 도구를 같이 포함합니다.

- `ffmpeg.exe`
- `whisper-cli.exe`
- `ggml-base.bin`

즉, Windows 사용자는 ffmpeg나 whisper를 따로 설치할 필요가 없습니다.

## 앱 안에서 바뀐 점

### 1) STT

- mac Apple Silicon은 `ffmpeg + bundled Python + faster-whisper(distil-large-v3-ct2)`를 우선 사용합니다.
- mac 번들 안에 distil-large-v3 모델 디렉터리와 Python 런타임을 같이 넣을 수 있습니다.
- mac에서 위 리소스를 찾지 못하면 기존 `whisper/whisper.cpp` 탐색 경로로 자동 fallback 합니다.
- Windows 기본 배포물은 `WASAPI loopback + ffmpeg + whisper.cpp` 조합으로 동작합니다.
- 오디오 캡처와 전사 파일이 앱 번들에 같이 들어갑니다.
- 압축만 제대로 풀면 STT 도구를 따로 찾을 필요가 없습니다.
- 실제 흐름은 `Windows 기본 출력 장치 재생 -> WASAPI loopback 캡처 -> whisper.cpp 전사 -> 번역 provider` 입니다.
- 기본값에서는 현재 Windows 기본 출력 장치를 자동으로 따라가며, Stereo Mix/VB-Cable 같은 가상 장치를 따로 잡을 필요가 없습니다.

### 2) UI 문구

메인/설정 흐름에서 아래 문구를 걷어냈습니다.

- `로컬 데모`
- `설정 필요`

대신 사용자는 아래처럼 보게 됩니다.

- `기본 확인`
- `입력 필요`
- `로그인 필요`

### 3) Provider 설정 UX

주의: `기본 확인`은 실오디오/STT 흐름 점검용입니다. 실제 번역을 쓰려면 아래 provider 중 하나를 설정해야 합니다.

가장 단순한 실사용 경로는 아래입니다.

1. 설정 화면에서 `실행 모드 = 실사용 권장`
2. `번역 경로 = 자동 선택`
3. GPT API / Gemini / DeepL 중 하나의 키만 저장
4. 설정 화면의 `첫 실행 기준` 카드에서 4개 체크가 채워졌는지 바로 확인
5. `연결 테스트` 또는 `자동 선택 테스트`로 바로 확인

자동 선택 우선순위는 아래 순서입니다.

- `GPT API`
- `Gemini`
- `DeepL`
- `Codex auth`

즉, Codex auth는 기본 경로가 아니라 고급/대체 경로입니다.

설정 화면에서 provider 카드를 누르면 실제 모달이 열립니다.

- `자동 선택`: 현재 저장된 키 기준 자동 선택 테스트
- `Codex auth`: Codex CLI 설치 + 로그인 페이지 열기 + auth 파일 경로 입력 + 모델 입력 + 연결 테스트
- `GPT API`: API 키 / Base URL / 모델 입력 + 연결 테스트
- `Gemini`: API 키 / Base URL / 모델 입력 + 연결 테스트
- `DeepL`: API 키 / Base URL 입력 + 연결 테스트

저장하면 앱 전용 설정 파일에 보관되고, 다음 실행부터 바로 반영됩니다.

## QA / Release

```bash
npm run prepare:stt:mac
npm run typecheck
npm run build
npm run verify:runtime:report
npm run release:windows
```

Windows 산출물은 `release/` 아래에 생성됩니다.
런타임 smoke 결과는 `artifacts/runtime-verify-latest.json`에 남길 수 있습니다.

## 현재 남는 리스크

- mac 실오디오 E2E는 입력 장치, 마이크 권한, 가상 오디오 라우팅이 준비되지 않으면 캡처 단계에서 막힙니다.
- distil-large-v3 런타임은 실제로 묶을 수 있게 바꿨지만, 리소스 크기가 커서 mac 배포물 용량이 꽤 증가합니다.
- faster-whisper 경로는 CPU int8 기준으로 붙여 두었고, Apple Silicon 최적화 전용 경로는 아직 아닙니다.
- Windows STT는 번들형으로 바꿨지만, 실제 인식 품질은 `ggml-base.bin` 모델 기준입니다. 더 높은 품질이 필요하면 더 큰 모델로 교체해야 합니다.
- Codex auth는 브라우저 로그인 진입만 앱에서 제공합니다. 실제 사용에는 해당 PC에 Codex CLI가 설치되어 있고 로그인 세션(auth.json)이 모두 준비돼 있어야 합니다.
- `기본 확인`은 실제 번역 엔진이 아니라 캡처/STT 점검용 경로라서, 원격 provider를 설정하지 않으면 실사용 번역기로 쓰기 어렵습니다.
- macOS는 여전히 시스템 오디오 라우팅 환경에 따라 입력 장치 구성이 달라질 수 있습니다.
