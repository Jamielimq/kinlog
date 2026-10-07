import { getApp } from '@react-native-firebase/app';
import {
  collection,
  doc,
  FirebaseFirestoreTypes,
  getFirestore,
  increment,
  onSnapshot,
  query,
  runTransaction,
  where,
} from '@react-native-firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sentState, type SentState } from '../lib/badgeClaim';
import { addPending, loadPending, type PendingClaim, removePending } from '../lib/pendingClaims';
import {
  badgeMonths,
  type DateKey,
  dayStartMs,
  type MonthKey,
  monthLabel,
  monthlyBadgeId,
  MONTHLY_BADGES,
  monthlyPointsId,
  monthlyReached,
  type MonthlyType,
} from '../lib/record';
import { getConnection } from '../lib/solana';

/** users/{wallet}/badges/month_<type>_<YYYYMM>: one monthly badge in one month (lib/record.ts). */
export interface MonthlyBadgeRecord {
  kind: 'monthly';
  type: MonthlyType;
  month: MonthKey;
  earned: boolean;
  earnedAt?: number; // local midnight of the day it was reached
  claimed: boolean;
  claimedAt?: number;
  txSignature?: string;
  memo?: string;
  pts?: number;
}

/** A claim the wallet sent that isn't recorded yet: being checked on chain, or confirmed and only the saving failed. */
export type SentClaimState = 'checking' | 'unsaved';

const RECHECK_MS = 15_000;
const SAVE_TRIES = 3;

/**
 * Records a confirmed claim and its points in one transaction: the badge record, its points_history
 * entry (a fixed id) and the cached total on users/{wallet}. If the record already says claimed,
 * nothing is written, so a retry or a second device can't add the points twice.
 */
async function recordClaim(address: string, c: Pick<PendingClaim, 'type' | 'month' | 'memo' | 'signature'>) {
  const badge = MONTHLY_BADGES.find(b => b.type === c.type);
  if (!badge) throw new Error(`unknown monthly badge ${c.type}`);
  const db = getFirestore(getApp());
  const badgeRef = doc(db, 'users', address, 'badges', monthlyBadgeId(c.type, c.month));
  await runTransaction(db, async tx => {
    const snap = await tx.get(badgeRef);
    if (snap.exists() && snap.data()?.claimed === true) return;
    const now = Date.now();
    tx.set(
      badgeRef,
      { kind: 'monthly', type: c.type, month: c.month, earned: true, claimed: true, claimedAt: now, txSignature: c.signature, memo: c.memo, pts: badge.pts },
      { merge: true },
    );
    tx.set(doc(db, 'users', address, 'points_history', monthlyPointsId(c.type, c.month)), {
      reason: `Claimed badge: ${badge.name} (${monthLabel(c.month)})`,
      amount: badge.pts,
      createdAt: now,
    });
    tx.set(doc(db, 'users', address), { points: increment(badge.pts), updatedAt: now }, { merge: true });
  });
}

/**
 * This wallet's monthly badges: the records by id (null until read), and the claims sent but not yet
 * recorded (null until read). A badge its workouts have earned is recorded once (claimed: false). A
 * sent claim is kept on the phone from the moment the wallet sends it (trackSent); confirmed ones are
 * recorded, failed or expired ones dropped, and the rest checked again when Goals is opened (recheck)
 * and every 15 seconds while any remain. useBadges and v1.3.3 only know the ids in ALL_BADGES, so
 * these records stay out of their way. Pass the session's dataAddress.
 */
export function useMonthlyBadges(address: string | null, days: Set<DateKey>, today: DateKey) {
  const [records, setRecords] = useState<Map<string, MonthlyBadgeRecord> | null>(null);
  const [sent, setSent] = useState<Map<string, SentClaimState> | null>(null);
  // Records being created, so a re-render doesn't start the same one twice.
  const creating = useRef(new Set<string>());
  const checking = useRef(false);

  useEffect(() => {
    setRecords(null);
    creating.current.clear();
    if (!address) return;
    const db = getFirestore(getApp());
    return onSnapshot(
      query(collection(db, 'users', address, 'badges'), where('kind', '==', 'monthly')),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) =>
        setRecords(new Map(snap.docs.map(d => [d.id, d.data() as MonthlyBadgeRecord]))),
      e => console.log('monthly badges read failed:', e?.message ?? e),
    );
  }, [address]);

  // Every badge earned so far as "type|month|day", a plain string so the effect below reruns only when it changes.
  const earned = badgeMonths(today)
    .flatMap(m => [...monthlyReached(days, m, today)].map(([type, day]) => `${type}|${m}|${day}`))
    .join(',');

  useEffect(() => {
    if (!address || !records || !earned) return;
    const db = getFirestore(getApp());
    for (const item of earned.split(',')) {
      const [type, month, day] = item.split('|') as [MonthlyType, MonthKey, DateKey];
      const id = monthlyBadgeId(type, month);
      if (records.has(id) || creating.current.has(id)) continue;
      creating.current.add(id);
      const ref = doc(db, 'users', address, 'badges', id);
      // Only if it doesn't exist yet, so it can never undo a claim recorded meanwhile.
      runTransaction(db, async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists()) {
          tx.set(ref, { kind: 'monthly', type, month, earned: true, earnedAt: dayStartMs(day), claimed: false });
        }
      }).catch(e => {
        console.log('monthly badge record failed:', e?.message ?? e);
        creating.current.delete(id);
      });
    }
  }, [address, records, earned]);

  /** Looks at every sent claim kept on the phone and settles what the chain can tell. */
  const recheck = useCallback(async () => {
    if (!address || checking.current) return;
    checking.current = true;
    try {
      const connection = getConnection();
      const outcome = new Map<string, SentClaimState>(); // by signature
      for (const p of await loadPending(address)) {
        let state: SentState = 'unknown';
        try {
          state = await sentState(connection, p.signature, p.lastValidBlockHeight);
        } catch (e: any) {
          console.log('sent claim check failed:', e?.message ?? e);
        }
        if (state === 'failed' || state === 'expired') {
          await removePending(address, p.signature);
        } else if (state === 'confirmed') {
          try {
            await recordClaim(address, p);
            await removePending(address, p.signature);
          } catch (e: any) {
            console.log('sent claim save failed:', e?.message ?? e);
            outcome.set(p.signature, 'unsaved');
          }
        } else {
          outcome.set(p.signature, 'checking');
        }
      }
      // Read again, so a claim sent while this ran shows too.
      setSent(new Map((await loadPending(address)).map(p => [p.id, outcome.get(p.signature) ?? 'checking'])));
    } finally {
      checking.current = false;
    }
  }, [address]);

  useEffect(() => {
    setSent(null);
    if (address) void recheck();
  }, [address, recheck]);

  const remaining = sent?.size ?? 0;
  useEffect(() => {
    if (!remaining) return;
    const t = setInterval(() => void recheck(), RECHECK_MS);
    return () => clearInterval(t);
  }, [remaining, recheck]);

  /** The wallet has sent the claim: keep it on the phone before anything else can go wrong. */
  const trackSent = useCallback(
    async (p: PendingClaim) => {
      if (!address) return;
      await addPending(address, p);
      setSent(prev => new Map(prev ?? []).set(p.id, 'checking'));
    },
    [address],
  );

  /** The claim is confirmed: record it (a few tries). False when saving failed; it is retried by recheck. */
  const settleSent = useCallback(
    async (p: PendingClaim): Promise<boolean> => {
      if (!address) return false;
      for (let i = 0; i < SAVE_TRIES; i++) {
        try {
          await recordClaim(address, p);
          await removePending(address, p.signature);
          setSent(prev => {
            const next = new Map(prev ?? []);
            next.delete(p.id);
            return next;
          });
          return true;
        } catch (e: any) {
          console.log('claim save failed:', e?.message ?? e);
        }
      }
      setSent(prev => new Map(prev ?? []).set(p.id, 'unsaved'));
      return false;
    },
    [address],
  );

  /** The claim failed on chain or can no longer land: forget it, so the badge can be claimed again. */
  const dropSent = useCallback(
    async (p: PendingClaim) => {
      if (!address) return;
      await removePending(address, p.signature);
      setSent(prev => {
        const next = new Map(prev ?? []);
        next.delete(p.id);
        return next;
      });
    },
    [address],
  );

  return { records, sent, recheck, trackSent, settleSent, dropSent };
}
