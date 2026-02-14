import {
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { haversineMeters, neighborCellIds, toCellId } from './geo';
import type { Player, Room, RoomSettings } from './types';

const defaultSettings: RoomSettings = {
  dangerRadiusM: 10,
  femaleCopRadiusMultiplier: 1.3,
  decayPerSecond: 1.3,
  catchThresholdMs: 5000,
  jailRadiusM: 18,
};

export const createRoom = async (
  db: Firestore,
  hostUid: string,
  placeName: string,
  centerLat: number,
  centerLng: number,
): Promise<string> => {
  const roomRef = doc(collection(db, 'rooms'));
  const now = Date.now();
  const expiresAt = now + 1000 * 60 * 60 * 6;

  const room: Room = {
    hostUid,
    status: 'LOBBY',
    placeName,
    centerLat,
    centerLng,
    cellId: toCellId(centerLat, centerLng),
    radiusM: 200,
    jailLat: centerLat,
    jailLng: centerLng,
    playersCount: 1,
    copsCount: 0,
    thievesCount: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt,
    settings: defaultSettings,
  };

  await setDoc(roomRef, {
    ...room,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    expiresAt: new Date(expiresAt),
  });

  return roomRef.id;
};

export const joinRoom = async (db: Firestore, roomId: string, player: Player): Promise<void> => {
  const playerRef = doc(db, 'rooms', roomId, 'players', player.uid);
  await setDoc(playerRef, {
    ...player,
    joinAt: serverTimestamp(),
    lastSeenAt: serverTimestamp(),
  });

  await updateDoc(doc(db, 'rooms', roomId), {
    playersCount: increment(1),
    updatedAt: serverTimestamp(),
  });
};

export const nearbyRooms = async (
  db: Firestore,
  lat: number,
  lng: number,
  maxDistanceM = 2500,
): Promise<Array<Room & { id: string; distanceM: number }>> => {
  const ids = neighborCellIds(lat, lng);
  const roomQuery = query(collection(db, 'rooms'), where('cellId', 'in', ids));
  const snapshots = await getDocs(roomQuery);

  return snapshots.docs
    .map((snapshot) => {
      const room = snapshot.data() as Room;
      const distanceM = haversineMeters(lat, lng, room.centerLat, room.centerLng);
      return { ...room, id: snapshot.id, distanceM };
    })
    .filter((room) => room.distanceM <= maxDistanceM)
    .sort((a, b) => a.distanceM - b.distanceM);
};

export const heartbeat = async (db: Firestore, roomId: string, uid: string, lat: number, lng: number): Promise<void> => {
  await updateDoc(doc(db, 'rooms', roomId, 'players', uid), {
    lastSeenAt: serverTimestamp(),
    lat,
    lng,
  });
};

export const attemptHostHandover = async (db: Firestore, roomId: string, candidateUid: string): Promise<boolean> => {
  return runTransaction(db, async (txn) => {
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnap = await txn.get(roomRef);
    if (!roomSnap.exists()) return false;

    const room = roomSnap.data() as Room;
    const hostSnap = await txn.get(doc(db, 'rooms', roomId, 'players', room.hostUid));
    const candidateSnap = await txn.get(doc(db, 'rooms', roomId, 'players', candidateUid));

    if (!candidateSnap.exists()) return false;

    const hostLastSeen = hostSnap.data()?.lastSeenAt?.toMillis?.() ?? 0;
    const hostIsOffline = Date.now() - hostLastSeen > 10_000;

    if (!hostIsOffline) return false;

    txn.update(roomRef, { hostUid: candidateUid, updatedAt: serverTimestamp() });
    return true;
  });
};

export const readRoom = async (db: Firestore, roomId: string): Promise<Room | null> => {
  const snapshot = await getDoc(doc(db, 'rooms', roomId));
  if (!snapshot.exists()) return null;
  return snapshot.data() as Room;
};
