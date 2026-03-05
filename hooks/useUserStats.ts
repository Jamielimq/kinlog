import { getApp } from '@react-native-firebase/app';
import { doc, getFirestore, onSnapshot } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';

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

export function useUserStats(address: string | null) {
  const [stats, setStats] = useState<UserStats>(DEFAULT_STATS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) {
      setStats(DEFAULT_STATS);
      setLoading(false);
      return;
    }

    const db = getFirestore(getApp());
    const userRef = doc(db, 'users', address);

    const unsubscribe = onSnapshot(userRef, snap => {
      const data = snap.data() ?? {};
      setStats({
        points: data.points ?? 0,
        totalSquats: data.totalSquats ?? 0,
        totalWorkouts: data.totalWorkouts ?? 0,
        currentStreak: data.currentStreak ?? 0,
        bestStreak: data.bestStreak ?? 0,
        dailyReps: data.dailyReps ?? 0,
        lastWorkoutDate: data.lastWorkoutDate ?? 0,
      });
      setLoading(false);
    });

    return unsubscribe;
  }, [address]);

  // Calculate this week's workouts
  const getWeekStart = () => {
    const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - d.getDay()); return d.getTime()
  }

  return { stats, loading };
}
