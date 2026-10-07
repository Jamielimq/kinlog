import { getApp } from '@react-native-firebase/app';
import { collection, FirebaseFirestoreTypes, getFirestore, onSnapshot } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { dateKeyOf, type DateKey, dayTotals, type WorkoutLite } from '../lib/record';

/**
 * Squats per local day over this wallet's whole history, with today's date, for the Goals tab's
 * record (lib/record.ts). The same query as useUserStats, so Firestore serves both from one listener.
 * Pass the session's dataAddress.
 */
export function useWorkoutDays(address: string | null) {
  const [workouts, setWorkouts] = useState<WorkoutLite[] | null>(null);
  // The calendar moves on at midnight and when the app comes back to the front.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const next = new Date(now);
    next.setHours(24, 0, 1, 0);
    const timer = setTimeout(() => setNow(Date.now()), next.getTime() - Date.now());
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') setNow(Date.now());
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [now]);

  useEffect(() => {
    setWorkouts(null);
    if (!address) return;
    const db = getFirestore(getApp());
    return onSnapshot(
      collection(db, 'users', address, 'workouts'),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) =>
        setWorkouts(
          snap.docs.map(d => {
            const x = d.data();
            return {
              reps: typeof x.reps === 'number' ? x.reps : 0,
              rawReps: typeof x.rawReps === 'number' ? x.rawReps : undefined,
              createdAt: typeof x.createdAt === 'number' ? x.createdAt : 0,
            };
          }),
        ),
      e => console.log('workouts read failed:', e?.message ?? e),
    );
  }, [address]);

  const today: DateKey = dateKeyOf(now);
  return {
    totals: workouts ? dayTotals(workouts, today) : new Map<DateKey, number>(),
    today,
    loading: !!address && workouts === null,
  };
}
