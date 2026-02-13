# 대용량 공정 로그 시계열 시각화 플랫폼 컨셉 (요구사항 반영 v3)

## 1) 핵심 방향 (질문에 대한 직접 답변)
- 네, **텍스트 로그를 파싱해 DB/컬럼 저장소에 구조화 저장**하는 것이 필터링·디스플레이·추가 분석에 가장 적합합니다.
- 다만 매번 전체 삭제 후 재적재는 비효율적이므로, **append-only + 증분 처리**가 정답입니다.
- 표시 전략은 요청하신 대로:
  1. `START/END`가 매칭되는 이벤트만 택트(구간 블록)로 표시
  2. 나머지 로그는 "해당 시점의 현재값(point/state)"으로 표시

---

## 2) 설치 부담 최소화 전략 (DB 포함)

### 2.1 PostgreSQL 설치 없이 가능한가?
- 엄밀히 말하면 **일반 PostgreSQL 서버는 설치/초기화가 필요**합니다.
- "설치 없이 바로 실행"이 핵심이면 PostgreSQL 단독은 불리합니다.

### 2.2 권장안 (설치 최소화 우선)
1. **기본 모드(권장)**: `SQLite + Parquet`
   - 앱과 함께 번들 가능, 별도 DB 서버 설치 불필요
   - 단일 실행파일/폴더 배포에 유리
2. **분석 확장 모드**: `DuckDB(임베디드) + Parquet`
   - 설치 없이 동작(라이브러리 포함)
   - 대용량 읽기/집계 성능 우수
3. **운영 서버 모드(선택)**: PostgreSQL/MariaDB 외부 연결
   - 다중 사용자/동시 쓰기 필요 시에만 활성화

즉, 초기 제품은 "설치 없는 임베디드 DB"로 가고, 나중에 서버 DB로 승격하는 방식이 가장 현실적입니다.

---

## 3) Descript 가변 포맷 대응 설계
`Descript`가 더 다양한 구조로 들어와도 대응 가능하도록 "고정 스키마 + 유연 payload" 혼합 방식을 사용합니다.

### 3.1 파싱 원칙
- 1차 분류: 마지막 토큰이 `START|END`인지 여부
- 2차 분류: 수치형 끝값인지(`...=70.00`) / 문자열 상태값인지 / 기타 자유 텍스트인지
- 3차 분류: 패턴 사전(dictionary) 매칭

### 3.2 저장 원칙
- **공통 컬럼(고정)**: `event_ts`, `ch`, `type`, `id1`, `glass`, `id2`, `id3`, `raw_line_id`
- **정규화 컬럼(선택)**: `action`, `from_unit`, `to_unit`, `phase`, `metric_name`, `metric_value`
- **유연 컬럼(필수)**: `desc_tokens_json`, `desc_raw`

즉, 모르는 신규 패턴이 와도 `desc_tokens_json/desc_raw`로 보존하고, 이후 파서 버전 업으로 재해석할 수 있습니다.

---

## 4) 데이터 계층 (Bronze/Silver/Gold)

### 4.1 Bronze (원본)
- append-only 원문 저장
- 키: `source_file`, `line_no`(또는 byte offset), `ingested_at`
- 절대 삭제하지 않음

### 4.2 Silver (정규화)
- Descript 토큰화/분류 결과 저장
- `event_kind`:
  - `interval_start`
  - `interval_end`
  - `point_metric`
  - `state_snapshot`
  - `unknown`
- 파서 버전(`parser_version`)과 신뢰도(`parse_confidence`) 저장

### 4.3 Gold (화면/분석용)
1. **Interval Block Table**: START/END 매칭 결과(택트/Gantt 블록)
2. **Point/State Table**: 현재값 표시용 시점 데이터
3. **Latest State View**: 채널/태그별 최신 상태 materialized view

---

## 5) START/END 매칭 + 현재값 표시 규칙

### 5.1 매칭 키
`action + ch + (id1, glass, id2, id3 nullable) + from_unit + to_unit`

### 5.2 매칭 로직
1. START 수신 → key별 open set에 push
2. END 수신 → 가장 근접 START와 페어링하여 interval block 생성
3. START만 존재 → `open_interval` 상태로 임시 표시
4. END만 존재 → `orphan_end`로 저장(품질 경고)

### 5.3 화면 표현
- **택트 표시**: `interval block`만 Gantt 막대
- **현재값 표시**: `point_metric/state_snapshot/unknown`은 라인 위 점/라벨/스파크라인으로 표현

요청하신 "모든 데이터를 다 갖지 못한 상황"에서도 이 방식이면 문제 없습니다.

---

## 6) Process Mining 기능

### 6.1 목적
- 단순 타임라인을 넘어 "프로세스 흐름" 자체를 분석
- 병목, 반복 루프, 비정상 경로를 시각화

### 6.2 최소 기능
1. **Variant 분석**: lot/recipe별 실제 수행 경로 빈도
2. **DFG(Directly-Follows Graph)**: 활동 A→B 전이 빈도/평균 지연
3. **병목 엣지 하이라이트**: 평균 대비 지연 증가 구간 강조
4. **Conformance 체크**: 기준 공정 모델 대비 이탈 경로 표시

### 6.3 타임라인 연동
- Process Mining에서 선택한 병목 엣지를 클릭하면,
  동일 시간대/동일 lot의 Gantt 구간으로 점프 링크 제공

---

## 7) UI 인터랙션 요구사항

### 7.1 세로 커서(Crosshair Time Cursor)
- 마우스 위치에 세로선 표시
- 상단에 정확한 시각(ms) 표시
- 해당 시점의 각 lane 상태(진행중 block / 최신 point 값)를 우측 패널에 동시 표시

### 7.2 Rect 확대(Zoom-to-Rect) + 스마트 맞춤
- 마우스로 사각형(Rect) 영역 드래그 지정 시 해당 영역으로 확대
- **스마트 우선 확대 모드**:
  - 선택 영역이 세로로 더 길면(Y span > X span) 세로 축 맞춤 우선
  - 선택 영역이 가로로 더 길면(X span > Y span) 가로 축 맞춤 우선
- **동시 XY 정확 맞춤 모드**:
  - 가로/세로를 동시에 맞춰 Rect가 화면에 딱 맞게 확대
  - 필요 시 축 비율 잠금/해제 옵션 제공
- 최소 확대 단위/최대 확대 배율 제한으로 과도한 줌 방지

### 7.3 확대 복귀/히스토리 네비게이션
- `ESC` 키 입력 시 직전 확대 상태(zoom stack 이전 상태)로 복귀
- `Ctrl+0` : 초기 전체 보기(Fit All) 복귀
- `Alt+Left/Alt+Right` : 이전/다음 뷰 히스토리 이동
- 우클릭 컨텍스트 메뉴에 `Reset Zoom` 제공

### 7.4 시간 측정(Measure Tool)
- 사용자가 A점, B점 클릭 → `Δt` 자동 계산
- 단위: ms/s/min 전환
- 동일 lane 내, lane 간 측정 모두 지원

### 7.5 Drag & Drop CSV 입력
- 파일 드롭 시 ingest 파이프라인 자동 시작
- 중복 파일 감지(hash) 및 스킵
- 진행률(파싱/매칭/적재) 표시

---

## 8) 객체별 Address 매핑 + 시뮬레이션 출력 (신규)
요청하신 "각 시그널이 객체를 갖고, 로그 대응 D영역 Address를 입력"하는 기능을 아래처럼 설계합니다.

### 8.1 Signal Registry (설정 화면)
- 컬럼:
  - `signal_name` (예: `VAC_DV_OPEN`)
  - `object_type` (valve/motor/sensor/...)
  - `channel` (LL01, PC03...)
  - `d_address` (정수 주소)
  - `start_cmd` (START 시 기록값)
  - `end_cmd` (END 시 기록값)
  - `metric_scale` (point 값 스케일)
- 이 설정은 UI에서 편집/저장(JSON or DB table)

### 8.2 재생(Replay) 엔진
- 타임라인 재생 시 이벤트 타임스탬프 순으로 실행
- `START/END` 이벤트를 만나면 registry를 조회해 해당 Address에 값 기록
- point_metric은 선택적으로 Address 갱신(예: 아날로그 값 write)

### 8.3 안전장치
- dry-run 모드(실제 DLL 호출 없이 로그만)
- 속도 배율(1x, 2x, 10x)
- 긴급 정지(stop all writes)
- write 이력 audit(`ts`, `address`, `value`, `source_event_id`)

---

## 9) Delphi DLL 연동을 Python으로 동일 구현
주신 Delphi 선언:
```pascal
procedure SharedMemPutCommand(dev: char; add, cmd: integer);
  external 'ShardMem.dll' index 12;
```

Python에서는 `ctypes`로 동일하게 호출 가능합니다.

```python
import ctypes
from ctypes import c_char, c_int

dll_path = r"C:\Windows\ShardMem.dll"
shm = ctypes.WinDLL(dll_path)
put_cmd = shm.SharedMemPutCommand
put_cmd.argtypes = [c_char, c_int, c_int]
put_cmd.restype = None

# 예: dev='D', address=1200, cmd=1(START)
put_cmd(b"D", 1200, 1)
```

권장 매핑 규칙:
- `START` -> `start_cmd` (예: 1)
- `END` -> `end_cmd` (예: 0)
- point metric -> 스케일링 후 정수 변환 write

주의:
- DLL 경로는 고정: `C:\Windows\ShardMem.dll`
- DLL 비트수(32/64bit)와 Python 비트수 일치 필요
- 주소 범위 검증 및 예외 로그 필수

---

## 10) 증분 적재 운영 (삭제/재적재 방지)
1. watermark(`last_file`, `last_offset`) 저장
2. 신규 라인만 파싱
3. idempotent upsert(고유키 기반 중복 방지)
4. late END 이벤트를 위해 최근 N분 재매칭 윈도우 유지

---

## 11) 2주 PoC 실행안 (업데이트)
1. Descript 유연 파서(unknown-safe)
2. START/END 매칭 + orphan/open 관리
3. Interval/Point 분리 저장 및 조회 API
4. DPG 타임라인 + Rect 확대/복귀(ESC) + 세로 커서 + 측정 도구
5. CSV Drag&Drop ingest UI
6. Signal Registry(Address 매핑) 화면
7. DLL 출력 replay(dry-run 포함)
8. Process Mining(DFG + 병목 엣지) 1차 탑재

완료 기준:
- 전체 재적재 없이 append 반영
- START/END 블록 + 현재값 동시 표시
- 세로 커서 시점 스냅샷과 Δt 측정 동작
- Address 매핑 기반 replay write 검증
- 병목 구간을 타임라인/그래프 양쪽에서 추적 가능

---

## 12) 최종 한 줄 제안
**"설치 없는 SQLite/DuckDB 기반으로 시작하고, 가변 Descript를 유연 파싱해 START/END는 택트 블록·나머지는 현재값으로 표현하며, Address 매핑 + DLL replay + Process Mining을 결합한 구조"가 가장 실용적입니다.**
