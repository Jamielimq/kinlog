import { getApp } from '@react-native-firebase/app';
import {
  collection,
  doc,
  FirebaseFirestoreTypes,
  getFirestore,
  onSnapshot,
  query,
  runTransaction,
  where,
} from '@react-native-firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { badgeMonths, type DateKey, dayStartMs, type MonthKey, monthlyBadgeId, monthlyReached, type MonthlyType } from '../lib/record';

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

/**
 * This wallet's monthly badge records by id (null until read). A badge its workouts have earned is
 * recorded once (claimed: false); claiming it is context/ClaimsContext.tsx's. useBadges and v1.3.3
 * only know the ids in ALL_BADGES, so these records stay out of their way. Pass the session's
 * dataAddress.
 */
export function useMonthlyBadges(address: string | null, days: Set<DateKey>, today: DateKey) {
  const [records, setRecords] = useState<Map<string, MonthlyBadgeRecord> | null>(null);
  // Records being created, so a re-render doesn't start the same one twice.
  const creating = useRef(new Set<string>());

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

  return records;
}
