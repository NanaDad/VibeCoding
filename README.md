# Log Timeline MVP

요청하신 Step 1~6 기준으로 실행 가능한 MVP입니다.

## Step 구성
- Step 1: CSV ingest + `Descript` 파싱 + SQLite 저장 + START/END 매칭
- Step 2: Dear PyGui UI 기본 화면 + CSV 로드 버튼
- Step 3: 확대/복귀 키 인터랙션 골격(ESC 이벤트 핸들링)
- Step 4: Crosshair/측정(A/B, Δt) 기본 동작
- Step 5: Signal Registry + replay(dry-run 포함)
- Step 5-UI: ShardMem Signal Monitor(세로 패널: Name/State/Value, ON=초록, OFF=빨강)
- Step 6: Process Mining DFG + 병목 엣지 top-N

## 실행
```bash
python -m app.main --db timeline.db ingest sample.csv
python -m app.main --db timeline.db blocks --limit 20
python -m app.main --db timeline.db points --limit 20
python -m app.main --db timeline.db mining --top 10
python -m app.main --db timeline.db registry-init registry.json
python -m app.main --db timeline.db replay --registry registry.json --dry-run
python -m app.main --db timeline.db ui
```

## 내 컴퓨터에서 실행해야 하나?
- CLI/테스트는 여기 환경에서도 실행 가능
- 실제 DLL 연동(`C:\Windows\ShardMem.dll`)과 운영 데이터 검증은 Windows 사용자 환경에서 실행 권장

## 테스트
```bash
python -m pytest -q
```
