import { getApp } from '@react-native-firebase/app';
import { collection, getFirestore, onSnapshot, query, where } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';

export interface DayData {
  label: string;   // 'M' | 'T' | 'W' | 'T' | 'F' | 'S' | 'S'
  reps: number;
  isToday: boolean;
}

function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, ...
  // Week starts Monday
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - ((day + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { monday, sunday };
}

export function useWeeklyChart(address: string | null) {
  const [days, setDays] = useState<DayData[]>(
    ['M','T','W','T','F','S','S'].map(label => ({ label, reps: 0, isToday: false }))
  );

  useEffect(() => {
    if (!address) return;

    const db = getFirestore(getApp());
    const { monday, sunday } = getWeekRange();

    const q = query(
      collection(db, 'users', address, 'workouts'),
      where('createdAt', '>=', monday.getTime()),
      where('createdAt', '<=', sunday.getTime()),
    );

    const unsubscribe = onSnapshot(q, snapshot => {
      // 요일별 reps 합산 (0=Mon ~ 6=Sun)
      const repsByDay: number[] = [0, 0, 0, 0, 0, 0, 0];

      snapshot.docs.forEach(d => {
        const createdAt: number = d.data().createdAt ?? 0;
        const reps: number = d.data().reps ?? 0;
        const date = new Date(createdAt);
        const jsDay = date.getDay(); // 0=Sun, 1=Mon, ...
        const idx = (jsDay + 6) % 7;  // 0=Mon ~ 6=Sun
        repsByDay[idx] += reps;
      });

      const todayIdx = (new Date().getDay() + 6) % 7;
      const labels = ['M','T','W','T','F','S','S'];

      setDays(labels.map((label, i) => ({
        label,
        reps: repsByDay[i],
        isToday: i === todayIdx,
      })));
    });

    return unsubscribe;
  }, [address]);

  return { days };
}
