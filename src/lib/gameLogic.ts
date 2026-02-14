import type { PlayerState } from './types';

export interface DangerInput {
  distanceM: number;
  dangerRadiusM: number;
  dtMs: number;
  decayPerSecond: number;
  previousDangerMs: number;
  catchThresholdMs: number;
}

export interface DangerResult {
  dangerTimeMs: number;
  state: PlayerState;
}

export const nextDangerState = ({
  distanceM,
  dangerRadiusM,
  dtMs,
  decayPerSecond,
  previousDangerMs,
  catchThresholdMs,
}: DangerInput): DangerResult => {
  if (previousDangerMs >= catchThresholdMs) {
    return { dangerTimeMs: previousDangerMs, state: 'CAUGHT' };
  }

  const inDanger = distanceM <= dangerRadiusM;
  const nextDangerTimeMs = inDanger
    ? previousDangerMs + dtMs
    : Math.max(0, previousDangerMs - decayPerSecond * dtMs);

  if (nextDangerTimeMs >= catchThresholdMs) {
    return { dangerTimeMs: nextDangerTimeMs, state: 'CAUGHT' };
  }

  if (inDanger) {
    return { dangerTimeMs: nextDangerTimeMs, state: 'DANGER' };
  }

  return {
    dangerTimeMs: nextDangerTimeMs,
    state: nextDangerTimeMs > 0 ? 'WARNING' : 'FREE',
  };
};
