# JP-KO Translator QA Checklist

## 이번 정리에서 확인한 항목

- 개발자용 문구 `로컬 데모`, `설정 필요` 제거 후 `기본 확인 / 입력 필요 / 로그인 필요`로 정리
- provider 카드 클릭 시 실제 모달 열림
- API 키 / Base URL / 모델 저장 가능
- Codex auth 로그인 진입 버튼 추가
- `기본 확인`은 실오디오/STT 점검용이고, 실제 번역은 원격 provider 설정이 필요함을 문구로 명시
- Windows 배포물에 `ffmpeg.exe`, `whisper-cli.exe`, `ggml-base.bin` 포함
- `npm run typecheck`
- `npm run build`
- `npm run release:windows`

## 현재 남는 리스크

- Windows STT는 번들형으로 바뀌었지만 기본 모델이 `ggml-base.bin`이라 고품질 모델보다 인식 품질이 낮을 수 있음
- Codex auth는 브라우저 로그인 진입을 제공하지만 실제 사용 여부는 로컬 세션 상태에 의존함
- macOS는 시스템 오디오 라우팅 환경에 따라 입력 장치 설정이 달라질 수 있음
