import { describe, expect, it } from 'vitest';
import { nextDangerState } from '../lib/gameLogic';

describe('nextDangerState', () => {
  it('accumulates danger time while in danger radius', () => {
    const result = nextDangerState({
      distanceM: 6,
      dangerRadiusM: 10,
      dtMs: 500,
      decayPerSecond: 1,
      previousDangerMs: 2000,
      catchThresholdMs: 5000,
    });

    expect(result.state).toBe('DANGER');
    expect(result.dangerTimeMs).toBe(2500);
  });

  it('decays danger time outside danger radius', () => {
    const result = nextDangerState({
      distanceM: 20,
      dangerRadiusM: 10,
      dtMs: 500,
      decayPerSecond: 2,
      previousDangerMs: 2000,
      catchThresholdMs: 5000,
    });

    expect(result.state).toBe('WARNING');
    expect(result.dangerTimeMs).toBe(1000);
  });

  it('flags CAUGHT when threshold reached', () => {
    const result = nextDangerState({
      distanceM: 2,
      dangerRadiusM: 10,
      dtMs: 600,
      decayPerSecond: 1,
      previousDangerMs: 4500,
      catchThresholdMs: 5000,
    });

    expect(result.state).toBe('CAUGHT');
    expect(result.dangerTimeMs).toBe(5100);
  });
});
