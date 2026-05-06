# Windows release guide

Windows 기본 배포물은 이제 실행 파일만 있는 껍데기가 아닙니다.

압축을 풀면 아래가 같이 들어 있습니다.

- `JP-KO Translator.exe`
- `resources/bin/win32/x64/ffmpeg.exe`
- `resources/bin/win32/x64/whisper-cli.exe`
- `resources/bin/win32/x64/ggml-base.bin`

즉, Windows 사용자는 ffmpeg / whisper를 따로 설치하지 않아도 됩니다.

## 사용 방법

1. zip을 **완전히** 압축 해제합니다.
2. `JP-KO Translator.exe`를 실행합니다.
3. 설정 화면에서 `첫 실행 기준` 카드가 보이는지 확인합니다.
4. provider 카드를 눌러 키 또는 로그인 정보를 입력합니다.
5. `API 키 1개 저장`과 `실사용 조합 유지`가 완료로 바뀌는지 봅니다.
6. 저장 후 `연결 테스트` 또는 `자동 선택 테스트`를 한 번 실행합니다.
7. 시작합니다.

## Provider 설정 흐름

앱 안에서 직접 설정할 수 있습니다.

- `Codex auth`
  - Codex CLI 설치
  - 로그인 페이지 열기
  - auth 파일 경로 입력
  - 모델 입력
- `GPT API`
  - API 키 / Base URL / 모델 입력
- `Gemini`
  - API 키 / Base URL / 모델 입력
- `DeepL`
  - API 키 / Base URL 입력

예전처럼 카드에 `설정 필요`만 보이고 끝나지 않습니다.

`기본 확인`은 실오디오/STT 경로만 점검하는 내장 확인 모드입니다. 실제 번역을 사용하려면 GPT API, Gemini, DeepL, Codex auth 중 하나를 설정해야 합니다.

## STT 동작 방식

- 오디오 캡처: `ffmpeg.exe`
- 음성 인식: `whisper.cpp`
- 기본 모델: `ggml-base.bin`
- 입력 소스: Windows WASAPI loopback
- 기본값은 현재 Windows 기본 출력 장치를 자동으로 따라가므로, Stereo Mix/VB-Cable 같은 가상 장치를 따로 만들 필요가 없습니다.

## smoke 확인용 명령

```bash
npm run verify:runtime:report
```

성공/실패와 provider probe, capture 준비 상태, end-to-end 요약은 `artifacts/runtime-verify-latest.json`에 남습니다.

non-Windows 호스트에서 이 명령을 돌릴 때 Windows용 번들 모델만 들어 있는 경우에는, 이제 `Windows에서 직접 실행해 확인` 안내로 분리해 표시합니다. 이 경우는 앱 결함이라기보다 호스트 불일치입니다.

## 현재 남는 제한

- 기본 모델은 `ggml-base.bin`이라 더 큰 모델보다 정확도가 낮을 수 있습니다.
- Codex auth는 로그인 진입만 앱에서 열어줍니다. 실제 사용에는 로컬 PC에 Codex CLI 설치와 로그인 세션(auth.json)이 모두 필요합니다.
- `기본 확인`은 실제 번역 엔진이 아니라 캡처/STT 점검용 경로입니다.
- Apple Silicon macOS에서 Windows용 `portable` 단일 exe 패키징은 여전히 제한이 있어서, 현재 주 산출물은 exe bundle zip입니다.
