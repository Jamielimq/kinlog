// Locked In days run on the 15:00 UTC (00:00 KST) boundary, as on chain and on the server
// (functions/src/time.ts). The rest of the app still uses the device's local midnight.
const KST_OFFSET_MS = 9 * 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** KST calendar date (YYYY-MM-DD): the id of the server's users/{wallet}/daily documents. */
export const kstDateKey = (ms: number) => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);

/** Day index of an instant within a cohort (0 = day one); may be negative or past the last day. */
export const cohortDayIndex = (startTs: number, daySeconds: number, atMs: number) =>
  Math.floor((atMs / 1000 - startTs) / daySeconds);

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A space that never breaks a line. Copy puts it between a date and the short word before it
 * ("after Oct 11"), so the two always land on the same line.
 */
export const NBSP = ' ';

/** "Oct 3, 15:00 UTC". A line can break only after the comma, never inside "Oct 3" or "15:00 UTC". */
export function formatUtc(sec: number): string {
  const d = new Date(sec * 1000);
  return `${MONTHS[d.getUTCMonth()]}${NBSP}${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${NBSP}UTC`;
}
