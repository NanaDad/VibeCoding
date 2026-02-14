export type RoomStatus = 'LOBBY' | 'COUNTDOWN' | 'PLAYING' | 'ENDED';
export type PlayerRole = 'cop' | 'thief';
export type PlayerState = 'FREE' | 'WARNING' | 'DANGER' | 'CAUGHT' | 'JAILED';

export interface RoomSettings {
  dangerRadiusM: number;
  femaleCopRadiusMultiplier: number;
  decayPerSecond: number;
  catchThresholdMs: number;
  jailRadiusM: number;
}

export interface Room {
  hostUid: string;
  status: RoomStatus;
  placeName: string;
  centerLat: number;
  centerLng: number;
  cellId: string;
  radiusM: number;
  jailLat: number;
  jailLng: number;
  playersCount: number;
  copsCount: number;
  thievesCount: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  countdownStartAt?: number;
  gameStartAt?: number;
  gameEndAt?: number;
  settings: RoomSettings;
}

export interface Player {
  uid: string;
  nickname: string;
  role: PlayerRole;
  state: PlayerState;
  isFemaleCop: boolean;
  joinAt: number;
  lastSeenAt: number;
  lat: number;
  lng: number;
  dangerTimeMs: number;
}
