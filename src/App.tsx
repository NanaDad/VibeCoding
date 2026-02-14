import { useMemo, useState } from 'react';
import { nextDangerState } from './lib/gameLogic';
import type { PlayerState } from './lib/types';
import { useGeolocation } from './hooks/useGeolocation';
import { useThreatFeedback } from './hooks/useThreatFeedback';
import './styles/app.css';

const statusText: Record<PlayerState, string> = {
  FREE: '자유 이동',
  WARNING: '경고: 경찰 접근 중',
  DANGER: '위험: 즉시 도주',
  CAUGHT: '검거됨: 감옥으로 이동',
  JAILED: '수감 완료',
};

function App() {
  const geo = useGeolocation();
  const [distanceM, setDistanceM] = useState(999);
  const [dangerTimeMs, setDangerTimeMs] = useState(0);
  const [state, setState] = useState<PlayerState>('FREE');

  const shouldFlash = useThreatFeedback(state);

  const preview = useMemo(
    () =>
      nextDangerState({
        distanceM,
        dangerRadiusM: 10,
        dtMs: 500,
        decayPerSecond: 1.2,
        previousDangerMs: dangerTimeMs,
        catchThresholdMs: 5000,
      }),
    [dangerTimeMs, distanceM],
  );

  return (
    <main className="app">
      {shouldFlash && <div className="flash-overlay" />}
      <h1>RUN & CAPTURE (MVP)</h1>
      <section className="panel">
        <h2>내 상태</h2>
        <p className={`state state-${state.toLowerCase()}`}>{statusText[state]}</p>
        <p>dangerTime: {Math.floor(dangerTimeMs)}ms</p>
      </section>

      <section className="panel">
        <h2>테스트 시뮬레이터 (도둑)</h2>
        <label>
          경찰까지 거리 (m)
          <input
            type="range"
            min={0}
            max={50}
            value={distanceM}
            onChange={(event) => setDistanceM(Number(event.target.value))}
          />
        </label>
        <p>{distanceM.toFixed(1)}m</p>
        <button
          onClick={() => {
            setDangerTimeMs(preview.dangerTimeMs);
            setState(preview.state);
          }}
        >
          500ms Tick 적용
        </button>
        <button
          onClick={() => {
            setDangerTimeMs(0);
            setState('FREE');
          }}
        >
          초기화
        </button>
      </section>

      <section className="panel">
        <h2>위치 권한/정확도</h2>
        {geo ? (
          <p>
            lat: {geo.lat.toFixed(6)}, lng: {geo.lng.toFixed(6)}, ±{Math.round(geo.accuracy)}m
          </p>
        ) : (
          <p>위치 권한 대기 중...</p>
        )}
      </section>
    </main>
  );
}

export default App;
