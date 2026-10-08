// The Goals tab's record, on the device's calendar: the days that met the daily goal, the streaks
// they make, the month grid, and the nine monthly badges. Pure and import-free, so every case can be
// checked without a device. Locked In keeps its own 15:00 UTC days (lib/lockedIn/time.ts).

export type DateKey = string; // 'YYYY-MM-DD', local calendar
export type MonthKey = string; // 'YYYY-MM'

/** A day counts once its squats reach the daily goal. */
export const DAILY_GOAL = 30;
/** Monthly badges start with this month; earlier months show on the calendar only. */
export const FIRST_BADGE_MONTH: MonthKey = '2026-10';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');

export function dateKeyOf(ms: number): DateKey {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const monthOf = (k: DateKey): MonthKey => k.slice(0, 7);

/** "October 2026". */
export function monthLabel(m: MonthKey): string {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
}

/** Whole days since 1970-01-01, so consecutive dates differ by exactly 1 whatever the clocks did. */
function dayNumber(k: DateKey): number {
  const [y, m, d] = k.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function addMonths(m: MonthKey, n: number): MonthKey {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

/** How many months b is after a. */
export function monthsBetween(a: MonthKey, b: MonthKey): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

export function daysInMonth(m: MonthKey): number {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export interface WorkoutLite {
  reps: number; // after the daily points cap
  rawReps?: number; // as counted on screen (signed workouts only)
  createdAt: number; // ms
}

/**
 * Squats per local day up to today. A session counts what the screen counted (rawReps) when the doc
 * has it; older docs (v1.3.3) only have reps, already capped so a day's sum reaches 30 exactly when the
 * goal was met.
 */
export function dayTotals(workouts: WorkoutLite[], today: DateKey): Map<DateKey, number> {
  const totals = new Map<DateKey, number>();
  for (const w of workouts) {
    if (!(w.createdAt > 0)) continue;
    const k = dateKeyOf(w.createdAt);
    if (k > today) continue; // a clock running ahead
    const n = typeof w.rawReps === 'number' ? w.rawReps : w.reps;
    totals.set(k, (totals.get(k) ?? 0) + (n > 0 ? n : 0));
  }
  return totals;
}

/** The days that met the daily goal. */
export function goalDays(totals: Map<DateKey, number>): Set<DateKey> {
  const days = new Set<DateKey>();
  totals.forEach((reps, k) => {
    if (reps >= DAILY_GOAL) days.add(k);
  });
  return days;
}

/**
 * Goal days in a row up to today (or up to yesterday while today isn't met yet), the longest such run
 * ever, and how many goal days there have been.
 */
export function streakStats(days: Set<DateKey>, today: DateKey): { current: number; best: number; total: number } {
  const t = dayNumber(today);
  const nums = [...days].map(dayNumber).filter(n => n <= t).sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = NaN;
  for (const n of nums) {
    run = n === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = n;
  }
  const current = prev === t || prev === t - 1 ? run : 0;
  return { current, best, total: nums.length };
}

/** The month as a Monday-first grid, always 6 weeks (42 cells, null outside the month), so it keeps one height. */
export function monthCells(m: MonthKey): (DateKey | null)[] {
  const [y, mo] = m.split('-').map(Number);
  const lead = (new Date(Date.UTC(y, mo - 1, 1)).getUTCDay() + 6) % 7;
  const n = daysInMonth(m);
  return Array.from({ length: 42 }, (_, i) => {
    const d = i - lead + 1;
    return d >= 1 && d <= n ? `${m}-${pad(d)}` : null;
  });
}

/** The months the calendar can show: from the first month with a workout to this month. */
export function monthRange(totals: Map<DateKey, number>, today: DateKey): { first: MonthKey; last: MonthKey } {
  let first = monthOf(today);
  totals.forEach((_, k) => {
    if (monthOf(k) < first) first = monthOf(k);
  });
  return { first, last: monthOf(today) };
}

export type MonthlyType = 'opener' | 'run3' | 'run5' | 'run7' | 'run10' | 'run14' | 'run21' | 'run25' | 'sweep';

export interface MonthlyBadge {
  type: MonthlyType;
  need: number | 'all'; // goal days in a row inside the month; 'all': every day of it
  name: string;
  rarity: 'Common' | 'Uncommon' | 'Rare' | 'Epic';
  pts: number; // points when claimed, below every lifetime badge of the same rarity (they come back each month)
}

/** Earned again each month; each month's badge is claimed on its own (lib/badgeClaim.ts). */
export const MONTHLY_BADGES: readonly MonthlyBadge[] = [
  { type: 'opener', need: 1, name: '1 Day', rarity: 'Common', pts: 10 },
  { type: 'run3', need: 3, name: '3 Days', rarity: 'Common', pts: 25 },
  { type: 'run5', need: 5, name: '5 Days', rarity: 'Uncommon', pts: 40 },
  { type: 'run7', need: 7, name: '7 Days', rarity: 'Uncommon', pts: 60 },
  { type: 'run10', need: 10, name: '10 Days', rarity: 'Uncommon', pts: 80 },
  { type: 'run14', need: 14, name: '14 Days', rarity: 'Rare', pts: 120 },
  { type: 'run21', need: 21, name: '21 Days', rarity: 'Rare', pts: 160 },
  { type: 'run25', need: 25, name: '25 Days', rarity: 'Rare', pts: 200 },
  { type: 'sweep', need: 'all', name: 'Full Month', rarity: 'Epic', pts: 300 },
];

/**
 * The Badges tab's line for a monthly badge, as two lines with "in a month." on the second, so the
 * closing phrase is never split (components/badges/BadgeCard.tsx fits them to the card).
 */
export function monthlyDesc(b: MonthlyBadge): string {
  if (b.need === 'all') return `${DAILY_GOAL} squats every day\nof a month.`;
  if (b.need === 1) return `${DAILY_GOAL} squats on any day\nin a month.`;
  return `${DAILY_GOAL} squats ${b.need} days in a row\nin a month.`;
}

/** users/{wallet}/badges/<id> for one monthly badge in one month: month_run3_202610. */
export const monthlyBadgeId = (type: MonthlyType, m: MonthKey) => `month_${type}_${m.replace('-', '')}`;

/** users/{wallet}/points_history/<id> for that claim's points: fixed, so a retry can't add them twice. */
export const monthlyPointsId = (type: MonthlyType, m: MonthKey) => `mb-${type}-${m.replace('-', '')}`;

/** The memo a claim carries on chain, naming the badge and its month. */
export const claimMemo = (type: MonthlyType, m: MonthKey) => `kinlog:badge:monthly:${type}:${m}`;

/** Local midnight of a date, in ms. */
export function dayStartMs(k: DateKey): number {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** The months that can earn monthly badges so far, oldest first. */
export function badgeMonths(today: DateKey): MonthKey[] {
  const out: MonthKey[] = [];
  for (let m = FIRST_BADGE_MONTH; m <= monthOf(today); m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * The monthly badges the month has earned so far, each with the day it was reached; none before
 * FIRST_BADGE_MONTH. Runs count only the month's own days, up to today, so a run from Sep 29 to Oct 3
 * gives October 3; a run that breaks and starts again is judged by its longest stretch.
 */
export function monthlyReached(days: Set<DateKey>, m: MonthKey, today: DateKey): Map<MonthlyType, DateKey> {
  const reached = new Map<MonthlyType, DateKey>();
  if (m < FIRST_BADGE_MONTH) return reached;
  const n = daysInMonth(m);
  let run = 0;
  for (let d = 1; d <= n; d++) {
    const k = `${m}-${pad(d)}`;
    if (k > today) break;
    run = days.has(k) ? run + 1 : 0;
    for (const b of MONTHLY_BADGES) {
      if (!reached.has(b.type) && (b.need === 'all' ? run === n : run >= b.need)) reached.set(b.type, k);
    }
  }
  return reached;
}

/** The monthly badges the month has earned so far; none before FIRST_BADGE_MONTH. */
export function monthlyEarned(days: Set<DateKey>, m: MonthKey, today: DateKey): Set<MonthlyType> {
  return new Set(monthlyReached(days, m, today).keys());
}
