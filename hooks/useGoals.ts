import { getApp } from '@react-native-firebase/app';
import { collection, doc, getFirestore, onSnapshot, setDoc } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';

export interface Goal {
  id: string;
  tag: 'Daily' | 'Weekly' | 'Monthly';
  title: string;
  current: number;
  total: number;
  color: string;
  note: string;
}

const DEFAULT_GOALS: Goal[] = [
  { id: 'daily',   tag: 'Daily',   title: '30 Squats',             current: 0, total: 30,  color: '#F59E0B', note: '30 more reps · earn +150 pts!' },
  { id: 'weekly',  tag: 'Weekly',  title: '210 Squats This Week',  current: 0, total: 210, color: '#0EA5E9', note: '210 reps to weekly goal' },
  { id: 'monthly', tag: 'Monthly', title: 'Work Out Every Day',    current: 0, total: 31,  color: '#57524E', note: 'sessions this month' },
];

export function useGoals(address: string | null) {
  const [goals, setGoals] = useState<Goal[]>(DEFAULT_GOALS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) {
      setGoals(DEFAULT_GOALS);
      setLoading(false);
      return;
    }

    const db = getFirestore(getApp());
    const goalsRef = collection(db, 'users', address, 'goals');

    const unsubscribe = onSnapshot(goalsRef, async snapshot => {
      if (snapshot.empty) {
        // Initialize default goals
        for (const goal of DEFAULT_GOALS) {
          const goalRef = doc(db, 'users', address, 'goals', goal.id);
          await setDoc(goalRef, {
            tag: goal.tag,
            title: goal.title,
            current: 0,
            total: goal.total,
            color: goal.color,
          }, { merge: true });
        }
        setGoals(DEFAULT_GOALS);
      } else {
        const data = snapshot.docs.map(d => {
          const base = DEFAULT_GOALS.find(g => g.id === d.id) ?? DEFAULT_GOALS[0];
          const current = d.data().current ?? 0;
          // Use total from Firebase if available, otherwise use default
          const total = d.data().total ?? base.total;
          const remaining = total - current;

          let note = ''
          if (base.id === 'monthly') {
            note = `${current} sessions this month`
          } else {
            note = remaining > 0 ? `${remaining} more · keep going!` : '🎉 Goal completed!'
          }

          return {
            ...base,
            current,
            total,
            note,
          };
        });
        setGoals(data);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, [address]);

  return { goals, loading };
}
