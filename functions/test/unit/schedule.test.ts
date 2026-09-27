import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateKeys, kstMidnight, monthStarts, nextScheduledStart } from "../../src/daily/schedule.ts";
import { cohortDayIndex, kstDateKey } from "../../src/time.ts";

const ids = (kind: number, year: number, month: number) => monthStarts(kind, { year, month }).map((s) => s.id % 100);

test("3-Day starts every third day and never spill into the next month", () => {
  assert.deepEqual(ids(0, 2026, 10), [1, 4, 7, 10, 13, 16, 19, 22, 25, 28]); // 31 days
  assert.deepEqual(ids(0, 2026, 11), [1, 4, 7, 10, 13, 16, 19, 22, 25, 28]); // 30 days: 28-30 fits
  assert.deepEqual(ids(0, 2027, 2), [1, 4, 7, 10, 13, 16, 19, 22, 25]); // 28 days: 28 would spill
  assert.deepEqual(ids(0, 2028, 2), [1, 4, 7, 10, 13, 16, 19, 22, 25]); // 29 days: still spills
  assert.deepEqual(ids(1, 2027, 2), [1, 8, 15, 22]); // 7-Day: 22-28 fits February
});

test("starts are 00:00 KST, i.e. 15:00 UTC the day before; ids are the KST date", () => {
  const s = monthStarts(0, { year: 2026, month: 10 }).find((x) => x.id === 20261004)!;
  assert.equal(new Date(s.startTs * 1000).toISOString(), "2026-10-03T15:00:00.000Z");
  assert.equal(s.startTs % 86_400, 54_000);
  assert.equal(s.daySeconds, 86_400);
});

test("next scheduled start honours createFrom and is strictly in the future", () => {
  const at = (iso: string) => Date.parse(iso) / 1000;
  assert.equal(nextScheduledStart(0, at("2026-09-29T03:00:00Z"), "2026-10-04")!.id, 20261004);
  assert.equal(nextScheduledStart(0, at("2026-09-29T03:00:00Z"), null)!.id, 20261001);
  assert.equal(nextScheduledStart(0, kstMidnight(2026, 10, 4), null)!.id, 20261007);
  assert.equal(nextScheduledStart(1, at("2026-09-29T03:00:00Z"), null)!.id, 20261001);
  assert.equal(nextScheduledStart(1, at("2026-10-02T00:00:00Z"), null)!.id, 20261008);
  assert.equal(nextScheduledStart(0, at("2026-12-29T00:00:00Z"), null)!.id, 20270101);
});

test("candidate keys cover the schedule around now plus test ids", () => {
  const keys = candidateKeys(Date.parse("2026-10-05T00:00:00Z"));
  const has = (kind: number, id: number) => keys.some((k) => k.kind === kind && k.id === id);
  assert.ok(has(0, 20260928) && has(0, 20261004) && has(0, 20261128));
  assert.ok(has(1, 20261008) && has(0, 1) && has(1, 20));
  assert.ok(!has(0, 21));
  assert.ok(keys.length <= 100, "one getMultipleAccounts call");
});

test("the Locked In day flips at 15:00 UTC", () => {
  assert.equal(kstDateKey(Date.parse("2026-10-03T14:59:59Z")), "2026-10-03");
  assert.equal(kstDateKey(Date.parse("2026-10-03T15:00:00Z")), "2026-10-04");
  const start = kstMidnight(2026, 10, 4);
  assert.equal(cohortDayIndex(start, 86_400, (start - 1) * 1000), -1);
  assert.equal(cohortDayIndex(start, 86_400, start * 1000), 0);
  assert.equal(cohortDayIndex(start, 86_400, (start + 86_400 * 3 - 1) * 1000), 2);
  assert.equal(cohortDayIndex(start, 600, (start + 1200) * 1000), 2);
});
