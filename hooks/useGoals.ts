import { getApp } from '@react-native-firebase/app';
import { collection, doc, FirebaseFirestoreTypes, getDoc, getFirestore, onSnapshot, query, setDoc, where } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export interface Goal {
  id: string;
  tag: 'Daily' | 'Weekly' | 'Monthly';
  title: string;
  current: number;
  total: number;
  color: string;
  note: string;
  dates?: number[]; // Monthly: the days of this month with a workout
}

export interface WeekDay {
  label: string; // 'M' | 'T' | 'W' | 'T' | 'F' | 'S' | 'S'
  reps: number;
  isToday: boolean;
}

const DAILY_TARGET = 30;
const WEEK_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const DEFAULT_GOALS: Goal[] = [
  { id: 'daily',   tag: 'Daily',   title: '30 Squats',             current: 0, total: 30,  color: '#F59E0B', note: '30 more reps · earn +150 pts!' },
  { id: 'weekly',  tag: 'Weekly',  title: 'Squat Every Day This Week', current: 0, total: 7, color: '#0EA5E9', note: '7 days to weekly goal' },
  { id: 'monthly', tag: 'Monthly', title: 'Work Out Every Day',    current: 0, total: 31,  color: '#57524E', note: 'sessions this month' },
];

interface WorkoutLite {
  reps: number;
  createdAt: number;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** The earlier of this month's 1st and this week's Monday: the oldest workout any goal counts. */
function periodStart(nowMs: number): number {
  const monday = startOfDay(nowMs);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const monthStart = startOfDay(nowMs);
  monthStart.setDate(1);
  return Math.min(monday.getTime(), monthStart.getTime());
}

/**
 * The three goals and this week's bars, worked out from the workouts themselves (the source of
 * truth) on the device's own calendar: today from midnight, the week from Monday, the month from
 * the 1st. A workout is saved only when it has reps, so a day with any workout is a day worked out.
 * `reps` is the count after the daily points cap, so today's total stays within the daily target.
 */
export function goalsFromWorkouts(workouts: WorkoutLite[], nowMs: number): { goals: Goal[]; week: WeekDay[] } {
  const today = startOfDay(nowMs);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  const monthStart = new Date(today);
  monthStart.setDate(1);
  const nextMonth = new Date(monthStart);
  nextMonth.setMonth(monthStart.getMonth() + 1);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

  let todayReps = 0;
  const weekReps = [0, 0, 0, 0, 0, 0, 0];
  const weekDays = new Set<number>();
  const monthDates = new Set<number>();
  for (const w of workouts) {
    const t = w.createdAt;
    if (!t) continue;
    const day = new Date(t);
    if (t >= today.getTime() && t < tomorrow.getTime()) todayReps += w.reps;
    if (t >= monday.getTime() && t < nextMonday.getTime()) {
      const i = (day.getDay() + 6) % 7; // 0 = Monday
      weekReps[i] += w.reps;
      weekDays.add(i);
    }
    if (t >= monthStart.getTime() && t < nextMonth.getTime()) monthDates.add(day.getDate());
  }

  const left = (current: number, total: number) =>
    total - current > 0 ? `${total - current} more · keep going!` : '🎉 Goal completed!';
  const [daily, weekly, monthly] = DEFAULT_GOALS;
  const dailyCurrent = Math.min(todayReps, DAILY_TARGET);
  const goals: Goal[] = [
    { ...daily, current: dailyCurrent, total: DAILY_TARGET, note: left(dailyCurrent, DAILY_TARGET) },
    { ...weekly, current: weekDays.size, total: 7, note: left(weekDays.size, 7) },
    {
      ...monthly,
      current: monthDates.size,
      total: daysInMonth,
      note: `${monthDates.size} sessions this month`,
      dates: [...monthDates].sort((a, b) => a - b),
    },
  ];
  const todayIdx = (today.getDay() + 6) % 7;
  const week = WEEK_LABELS.map((label, i) => ({ label, reps: weekReps[i], isToday: i === todayIdx }));
  return { goals, week };
}

/**
 * Daily, Weekly and Monthly goals for the Home and Goals screens, counted from the workouts. The
 * goals documents (users/{wallet}/goals) are still kept for other readers: the workout save writes
 * them, and a document left from an earlier day, week or month is reset here as before.
 */
export function useGoals(address: string | null) {
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

  // Only the workouts the goals count are read, a single-field range on createdAt (no composite
  // index). A new week or month moves the start, and the read starts over from there.
  const from = periodStart(now);
  useEffect(() => {
    setWorkouts(null);
    if (!address) return;
    const db = getFirestore(getApp());

    // Documents left from an earlier period start over (other screens and v1.3.3 read them).
    const resetStale = async () => {
      const todayTs = startOfDay(Date.now()).getTime();
      const dailyRef = doc(db, 'users', address, 'goals', 'daily');
      const dailySnap = await getDoc(dailyRef);
      if ((dailySnap.data()?.lastResetDate ?? 0) < todayTs) {
        await setDoc(dailyRef, { current: 0, lastResetDate: todayTs }, { merge: true });
      }

      // Monday start
      const ws = startOfDay(Date.now());
      ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7));
      const weekTs = ws.getTime();
      const weeklyRef = doc(db, 'users', address, 'goals', 'weekly');
      const weeklySnap = await getDoc(weeklyRef);
      if ((weeklySnap.data()?.lastResetDate ?? 0) < weekTs) {
        await setDoc(weeklyRef, { current: 0, lastResetDate: weekTs }, { merge: true });
      }

      const ms = startOfDay(Date.now());
      ms.setDate(1);
      const monthTs = ms.getTime();
      const monthlyRef = doc(db, 'users', address, 'goals', 'monthly');
      const monthlySnap = await getDoc(monthlyRef);
      if ((monthlySnap.data()?.lastResetDate ?? 0) < monthTs) {
        const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
        await setDoc(monthlyRef, { current: 0, total: daysInMonth, lastResetDate: monthTs }, { merge: true });
      }
    };
    resetStale().catch(e => console.log('goals reset failed:', e?.message ?? e));

    return onSnapshot(
      query(collection(db, 'users', address, 'workouts'), where('createdAt', '>=', from)),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) =>
        setWorkouts(snap.docs.map(d => ({ reps: d.data().reps ?? 0, createdAt: d.data().createdAt ?? 0 }))),
      e => console.log('workouts read failed:', e?.message ?? e),
    );
  }, [address, from]);

  const { goals, week } = workouts ? goalsFromWorkouts(workouts, now) : { goals: DEFAULT_GOALS, week: goalsFromWorkouts([], now).week };
  return { goals, week, loading: !!address && workouts === null };
}
