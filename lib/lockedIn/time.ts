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

/** "Oct 3, 15:00 UTC" */
export function formatUtc(sec: number): string {
  const d = new Date(sec * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
