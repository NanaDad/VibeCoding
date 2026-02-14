import { useEffect, useState } from 'react';

export interface GeoState {
  lat: number;
  lng: number;
  accuracy: number;
}

export const useGeolocation = (): GeoState | null => {
  const [geo, setGeo] = useState<GeoState | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setGeo({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 1000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  return geo;
};
