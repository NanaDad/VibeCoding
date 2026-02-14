import { describe, expect, it } from 'vitest';
import { haversineMeters, neighborCellIds, toCellId } from '../lib/geo';

describe('geo helpers', () => {
  it('returns short distance in meters', () => {
    const d = haversineMeters(37.5665, 126.978, 37.5666, 126.978);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(12);
  });

  it('creates deterministic cell id', () => {
    expect(toCellId(37.5, 127.0)).toBe(toCellId(37.5, 127.0));
  });

  it('returns 9 surrounding cells', () => {
    expect(neighborCellIds(37.5, 127.0)).toHaveLength(9);
  });
});
