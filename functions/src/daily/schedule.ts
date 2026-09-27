// Cohort calendar (docs/LOCKED_IN.md section 3). Real cohorts start at 00:00 KST on fixed days of a
// KST month and never spill into the next month; their id is the KST start date as YYYYMMDD.
import { DAYS_FOR_KIND, SECONDS_PER_DAY } from "../chain/program.ts";
import type { CohortKey } from "../chain/types.ts";

const START_DAYS: readonly (readonly number[])[] = [
  [1, 4, 7, 10, 13, 16, 19, 22, 25, 28], // 3-Day
  [1, 8, 15, 22], // 7-Day
];
/** Test cohorts (shorter days, created with the CLI) use these small ids. */
export const TEST_COHORT_IDS = 20;

const KST_OFFSET_S = 9 * 3_600;

export interface ScheduledStart {
  kind: number;
  id: number;
  startTs: number;
  daySeconds: number;
}

export interface YearMonth {
  year: number;
  month: number; // 1-12
}
export function kstYearMonth(ms: number): YearMonth {
  const d = new Date(ms + KST_OFFSET_S * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
export function addMonths(ym: YearMonth, n: number): YearMonth {
  const i = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(i / 12), month: (i % 12) + 1 };
}
/** Unix seconds of 00:00 KST on a KST calendar date. */
export const kstMidnight = (year: number, month: number, day: number) => Date.UTC(year, month - 1, day) / 1000 - KST_OFFSET_S;

export function monthStarts(kind: number, { year, month }: YearMonth): ScheduledStart[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = DAYS_FOR_KIND[kind];
  return START_DAYS[kind]
    .filter((d) => d + days - 1 <= daysInMonth)
    .map((d) => ({ kind, id: year * 10_000 + month * 100 + d, startTs: kstMidnight(year, month, d), daySeconds: SECONDS_PER_DAY }));
}

/** First scheduled start after `nowSec` and not before `createFrom` (KST YYYY-MM-DD), within three months. */
export function nextScheduledStart(kind: number, nowSec: number, createFrom: string | null): ScheduledStart | null {
  let fromTs = -Infinity;
  if (createFrom) {
    const [y, m, d] = createFrom.split("-").map(Number);
    fromTs = kstMidnight(y, m, d);
  }
  const here = kstYearMonth(nowSec * 1000);
  for (let i = 0; i < 3; i++) {
    for (const s of monthStarts(kind, addMonths(here, i))) {
      if (s.startTs > nowSec && s.startTs >= fromTs) return s;
    }
  }
  return null;
}

/** Cohort accounts worth looking for: last, this and next KST month for both kinds, plus test ids. */
export function candidateKeys(nowMs: number): CohortKey[] {
  const here = kstYearMonth(nowMs);
  const keys: CohortKey[] = [];
  for (const kind of [0, 1]) {
    for (const n of [-1, 0, 1]) for (const s of monthStarts(kind, addMonths(here, n))) keys.push({ kind, id: s.id });
    for (let id = 1; id <= TEST_COHORT_IDS; id++) keys.push({ kind, id });
  }
  return keys;
}
