import { getApp } from '@react-native-firebase/app';
import { collection, doc, FirebaseFirestoreTypes, getFirestore, onSnapshot } from '@react-native-firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { cohortPda, decodeCohort, type Slot } from '../lib/lockedIn/program';
import { kstDateKey } from '../lib/lockedIn/time';
import type { JoinedCohort } from '../lib/lockedIn/visibility';
import { getConnection } from '../lib/solana';
import type { CohortView } from './useCohorts';

/** users/{wallet}/lockedIn/{cohort}: written by the server only (functions/src/workout, crank). */
export interface LockedInProgress {
  dayReps?: number[];
  allMet?: boolean;
  success?: boolean;
  successTx?: string;
  pointsAwarded?: boolean;
  square?: number;
  targetRound?: string;
  settled?: boolean;
  tier?: number;
  amount?: string;
  claimed?: boolean;
  returned?: boolean;
}

const DAY = 86_400;

/**
 * One wallet's place in one cohort. The on-chain slot is the authority for joined and its flags;
 * the server's records add progress. Pass the session's dataAddress.
 */
export function useLockedIn(cohort: CohortView | null, address: string | null) {
  const key = cohort?.key ?? null;
  const kind = cohort?.kind;
  const id = cohort?.id;
  const [progress, setProgress] = useState<LockedInProgress | null>(null);
  const [daily, setDaily] = useState<Record<string, number>>({});
  // undefined while loading, null when the wallet has no slot in the cohort.
  const [slot, setSlot] = useState<Slot | null | undefined>(undefined);
  // Seats as the chain has them: the server's mirror on the cohort document can be a minute behind.
  const [seats, setSeats] = useState<{ participants: number; capacity: number } | null>(null);

  useEffect(() => {
    setProgress(null);
    if (!key || !address) return;
    const db = getFirestore(getApp());
    return onSnapshot(
      doc(db, 'users', address, 'lockedIn', key),
      snap => setProgress((snap.data() as LockedInProgress | undefined) ?? null),
      e => console.log('lockedIn read failed:', e?.message ?? e),
    );
  }, [key, address]);

  // A real cohort's days are KST calendar days, so the server's daily totals line up with them and
  // include workouts done before joining (the success check counts those too). Test cohorts use
  // the server's per-cohort dayReps instead.
  const realDays = cohort && cohort.daySeconds === DAY
    ? Array.from({ length: cohort.days }, (_, i) => kstDateKey((cohort.startTs + i * DAY) * 1000))
    : [];
  const dayKeys = realDays.join(',');

  useEffect(() => {
    setDaily({});
    if (!address || !dayKeys) return;
    const db = getFirestore(getApp());
    const unsubs = dayKeys.split(',').map(day =>
      onSnapshot(
        doc(db, 'users', address, 'daily', day),
        snap => setDaily(prev => ({ ...prev, [day]: snap.data()?.reps ?? 0 })),
        e => console.log('daily read failed:', e?.message ?? e),
      ),
    );
    return () => unsubs.forEach(u => u());
  }, [address, dayKeys]);

  /** Re-reads the cohort account. Resolves to this wallet's slot (null if none), or undefined if the read failed. */
  const refresh = useCallback(async (): Promise<Slot | null | undefined> => {
    if (kind === undefined || id === undefined || !address) {
      setSlot(undefined);
      setSeats(null);
      return undefined;
    }
    try {
      const info = await getConnection().getAccountInfo(cohortPda(kind, id));
      const c = info ? decodeCohort(info.data) : null;
      const mine = c?.slots.find(s => s.user.toBase58() === address) ?? null;
      setSlot(mine);
      setSeats(c ? { participants: c.participants, capacity: c.capacity } : null);
      return mine;
    } catch (e: any) {
      console.log('cohort account read failed:', e?.message ?? e);
      return undefined;
    }
  }, [kind, id, address]);

  // Re-read the chain whenever the server's record changes (it mirrors slot changes within a minute).
  useEffect(() => {
    void refresh();
  }, [refresh, progress]);

  const dayReps = dayKeys ? realDays.map(d => daily[d] ?? 0) : progress?.dayReps ?? [];
  const joined = !!slot || !!progress;

  return { progress, slot, seats, joined, dayReps, refresh };
}

/**
 * The cohorts this wallet is in, from the server's lockedIn records (mirrored from chain within a
 * minute, functions/src/crank/everyMinute.ts syncSlots). The server adds `square` and `claimed` only
 * after a Square is picked; `claimed` is the on-chain CLAIMED flag, which only claim_reward sets.
 * So a picked Square whose ORE hasn't been received reads picked = true, claimed = false.
 */
export function useJoinedCohorts(address: string | null) {
  const [joined, setJoined] = useState<JoinedCohort[]>([]);

  useEffect(() => {
    setJoined([]);
    if (!address) return;
    const db = getFirestore(getApp());
    return onSnapshot(
      collection(db, 'users', address, 'lockedIn'),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) =>
        setJoined(
          snap.docs.map(d => {
            const x = d.data();
            return {
              key: d.id,
              returned: x.returned === true,
              success: x.success === true,
              picked: typeof x.square === 'number',
              claimed: x.claimed === true,
            };
          }),
        ),
      e => console.log('lockedIn list failed:', e?.message ?? e),
    );
  }, [address]);

  return joined;
}
