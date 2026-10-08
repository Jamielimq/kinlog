import { getApp } from '@react-native-firebase/app';
import { collection, FirebaseFirestoreTypes, getFirestore, onSnapshot } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';
import { dateKeyOf, dayTotals, goalDays, streakStats, type WorkoutLite } from '../lib/record';

export interface UserStats {
  points: number;
  totalSquats: number;
  totalWorkouts: number;
  currentStreak: number;
  bestStreak: number;
  dailyReps: number;
  lastWorkoutDate: number;
}

const DEFAULT_STATS: UserStats = {
  points: 0,
  totalSquats: 0,
  totalWorkouts: 0,
  currentStreak: 0,
  bestStreak: 0,
  dailyReps: 0,
  lastWorkoutDate: 0,
}

// Stats are derived from points_history + workouts subcollections (the source
// of truth) rather than from the denormalized cache on the parent user doc.
// This makes the UI resilient to a wiped or partially-written user doc:
// even if initUserInFirestore's recovery hasn't fired yet, display is correct.
// Streaks count days that reached the daily goal, as the Goals tab does
// (lib/record.ts), so Home, Profile and Goals show the same numbers;
// totalWorkouts still counts every day with a workout.
export function useUserStats(address: string | null) {
  const [stats, setStats] = useState<UserStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Nothing from the previous wallet shows, and loading lasts until both reads below are in.
    setStats(DEFAULT_STATS);
    if (!address) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const db = getFirestore(getApp());

    let pointsTotal = 0;
    let workoutsCache: WorkoutLite[] = [];
    let pointsReady = false;
    let workoutsReady = false;

    const compute = () => {
      const today = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();

      let totalSquats = 0;
      let lastWorkoutDate = 0;
      let dailyReps = 0;
      const dayStarts = new Set<number>();
      for (const w of workoutsCache) {
        totalSquats += w.reps;
        if (w.createdAt > 0) {
          if (w.createdAt > lastWorkoutDate) lastWorkoutDate = w.createdAt;
          if (w.createdAt >= today) dailyReps += w.reps;
          const ds = new Date(w.createdAt); ds.setHours(0,0,0,0);
          dayStarts.add(ds.getTime());
        }
      }
      const totalWorkouts = dayStarts.size;
      const todayKey = dateKeyOf(Date.now());
      const { current: currentStreak, best: bestStreak } = streakStats(goalDays(dayTotals(workoutsCache, todayKey)), todayKey);

      setStats({
        points: pointsTotal,
        totalSquats,
        totalWorkouts,
        currentStreak,
        bestStreak,
        dailyReps,
        lastWorkoutDate,
      });
      if (pointsReady && workoutsReady) setLoading(false);
    };

    const unsubPoints = onSnapshot(
      collection(db, 'users', address, 'points_history'),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) => {
        pointsTotal = 0;
        snap.forEach(d => { pointsTotal += d.data().amount ?? 0; });
        pointsReady = true;
        compute();
      },
    );
    const unsubWorkouts = onSnapshot(
      collection(db, 'users', address, 'workouts'),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) => {
        workoutsCache = snap.docs.map(d => ({
          reps: d.data().reps ?? 0,
          rawReps: typeof d.data().rawReps === 'number' ? d.data().rawReps : undefined,
          createdAt: d.data().createdAt ?? 0,
        }));
        workoutsReady = true;
        compute();
      },
    );

    return () => {
      unsubPoints();
      unsubWorkouts();
    };
  }, [address]);

  return { stats, loading };
}
