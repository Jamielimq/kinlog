// Challenge progress updater — called from saveWorkout after a successful
// rep save. Walks every active challenge instance, marks failure on
// expiration / missed days, otherwise records today's reps. Status
// transitions follow firestore.rules: active -> {active, completed, failed}.
//
// Date keys are local-day "YYYY-MM-DD" so they line up with the user's
// "did I work out today?" mental model and getTodayStart() in workout.tsx.
//
// Requirement values come from instance.requirementSnapshot, NOT the live
// catalog — this protects in-flight runs from operator edits.

import { getApp } from '@react-native-firebase/app';
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  query,
  setDoc,
  where,
} from '@react-native-firebase/firestore';
import type { UserChallengeInstance } from './useChallenges';

const DAY_MS = 86400000;

export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localDayStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function elapsedDays(startMs: number, nowMs: number): number {
  return Math.floor((localDayStartMs(nowMs) - localDayStartMs(startMs)) / DAY_MS);
}

type DaysLog = Record<string, { reps: number; met: boolean }>;

interface Outcome {
  status: 'active' | 'completed' | 'failed';
  progress: { dayIndex: number; daysLog: DaysLog; lastProgressDate: string };
  completedAt?: number;
  failedAt?: number;
}

function computeOutcome(
  instance: UserChallengeInstance,
  todayDailyReps: number,
  now: number,
): Outcome {
  const req = instance.requirementSnapshot;
  const todayKey = localDateKey(now);
  const elapsed = elapsedDays(instance.startedAt, now); // 0 on start day
  const dayIndex = elapsed + 1;                          // 1-based: start day == 1
  const daysLog: DaysLog = { ...(instance.progress.daysLog ?? {}) };

  // (b) Expiration: today is past the final day of the window.
  // Last allowed day = startDay + (requirementDays - 1).
  if (elapsed > req.requirementDays - 1) {
    return {
      status: 'failed',
      progress: { dayIndex, daysLog, lastProgressDate: todayKey },
      failedAt: now,
    };
  }

  // (c) Missed-day check: every day from startDay..yesterday must be met.
  const startDayMs = localDayStartMs(instance.startedAt);
  const todayDayMs = localDayStartMs(now);
  for (let m = startDayMs; m < todayDayMs; m += DAY_MS) {
    if (!daysLog[localDateKey(m)]?.met) {
      return {
        status: 'failed',
        progress: { dayIndex, daysLog, lastProgressDate: todayKey },
        failedAt: now,
      };
    }
  }

  // (d) Record today (absolute overwrite — caller passes the cumulative).
  daysLog[todayKey] = {
    reps: todayDailyReps,
    met: todayDailyReps >= req.requirementDailyReps,
  };

  // (f) Completion: count met days; complete when reaching requirementDays.
  let metCount = 0;
  for (const k in daysLog) if (daysLog[k].met) metCount++;

  if (metCount >= req.requirementDays) {
    return {
      status: 'completed',
      progress: { dayIndex, daysLog, lastProgressDate: todayKey },
      completedAt: now,
    };
  }

  return {
    status: 'active',
    progress: { dayIndex, daysLog, lastProgressDate: todayKey },
  };
}

// Build the minimal patch — merge:true preserves immutable fields,
// rule's unchanged() checks then pass automatically.
function buildPatch(
  outcome: Outcome,
  prevStatus: UserChallengeInstance['status'],
): Record<string, unknown> {
  if (outcome.status === prevStatus) {
    return { progress: outcome.progress };
  }
  if (outcome.status === 'completed') {
    return {
      status: 'completed',
      progress: outcome.progress,
      completedAt: outcome.completedAt,
    };
  }
  return {
    status: 'failed',
    progress: outcome.progress,
    failedAt: outcome.failedAt,
  };
}

export async function updateChallengeProgress(
  address: string,
  todayDailyReps: number,
  now: number,
): Promise<void> {
  const db = getFirestore(getApp());
  const colRef = collection(db, 'users', address, 'userChallenges');

  const activeSnap = await getDocs(query(colRef, where('status', '==', 'active')));
  if (activeSnap.empty) return;

  const tasks = activeSnap.docs.map(async d => {
    const instance: UserChallengeInstance = {
      ...(d.data() as Omit<UserChallengeInstance, 'id'>),
      id: d.id,
    };
    const outcome = computeOutcome(instance, todayDailyReps, now);
    const patch = buildPatch(outcome, instance.status);
    await setDoc(
      doc(db, 'users', address, 'userChallenges', instance.id),
      patch,
      { merge: true },
    );
  });

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('Challenge progress update failed:', r.reason);
    }
  }
}
