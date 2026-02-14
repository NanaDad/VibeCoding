# RUN & CAPTURE (MVP Skeleton)

실외 추격 게임 웹앱의 MVP 뼈대입니다.

## 포함된 범위
- React + TypeScript + Vite 기반 모바일 웹앱
- Firebase Auth/Firestore 연결 코드
- Firestore rooms/players 스키마 타입
- Grid Cell 기반 근처 방 조회 helper
- dangerTime 누적/감쇠 기반 검거 로직
- 상태 기반 비프/진동/화면 플래시 오버레이
- Firestore Rules 초안

## 시작 방법
```bash
npm install
cp .env.example .env
npm run dev
```

## 테스트
```bash
npm test
```

## 다음 구현 우선순위
1. 실제 화면 플로우(로그인/근처방/로비/게임/결과) 라우팅 분리
2. Firestore 실시간 구독(onSnapshot) 기반 플레이어 상태 동기화
3. 경찰 집결 판정 + 30초/10초 카운트다운 자동화
4. 방장 승계 후보 선출(최초 joinAt 기준) 및 트랜잭션 확장
5. TTL 정책(`rooms.expiresAt`) Firebase 콘솔 적용
