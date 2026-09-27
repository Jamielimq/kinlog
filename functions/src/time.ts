// Locked In days run on the 15:00 UTC (00:00 KST) boundary; test cohorts on their own day length.
const KST_OFFSET_MS = 9 * 3_600_000;

/** KST calendar date (YYYY-MM-DD) of an instant. */
export const kstDateKey = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

/** Day index of an instant within a cohort (0 = day one); may be negative or past the last day. */
export const cohortDayIndex = (startTs: number, daySeconds: number, atMs: number) =>
  Math.floor((atMs / 1000 - startTs) / daySeconds);
