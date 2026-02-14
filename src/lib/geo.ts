const EARTH_RADIUS_M = 6371000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

export const haversineMeters = (
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number => {
  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);
  const lat1 = toRad(fromLat);
  const lat2 = toRad(toLat);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
};

export const toCellId = (lat: number, lng: number, cellSize = 0.0025): string => {
  const latCell = Math.floor(lat / cellSize);
  const lngCell = Math.floor(lng / cellSize);
  return `${latCell}:${lngCell}`;
};

export const neighborCellIds = (lat: number, lng: number, cellSize = 0.0025): string[] => {
  const latCell = Math.floor(lat / cellSize);
  const lngCell = Math.floor(lng / cellSize);
  const ids: string[] = [];

  for (let y = -1; y <= 1; y += 1) {
    for (let x = -1; x <= 1; x += 1) {
      ids.push(`${latCell + y}:${lngCell + x}`);
    }
  }

  return ids;
};
