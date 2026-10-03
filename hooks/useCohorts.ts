import { getApp } from '@react-native-firebase/app';
import { collection, doc, FirebaseFirestoreTypes, getDoc, getFirestore, onSnapshot, query, where } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';

// Locked In cohorts as the server mirrors them into cohorts/{kind}-{id} (functions/src/cohorts.ts).
// Test cohorts (shorter days) are readable only by wallets listed in config/testers.
export interface CohortView {
  key: string; // document id, `${kind}-${id}`
  kind: number; // 0 = 3-Day, 1 = 7-Day
  id: number;
  days: number;
  daySeconds: number;
  startTs: number; // seconds
  endTs: number;
  deadlineTs: number;
  depositAmount: bigint; // raw SKR
  feeLamports: bigint;
  capacity: number;
  participants: number;
  status: string; // scheduled | running | ended | closing | closed
  isTest: boolean;
}

function toView(snap: FirebaseFirestoreTypes.DocumentSnapshot): CohortView | null {
  const x = snap.data();
  if (!x || typeof x.startTs !== 'number' || typeof x.kind !== 'number') return null;
  return {
    key: snap.id,
    kind: x.kind,
    id: x.id,
    days: x.days,
    daySeconds: x.daySeconds,
    startTs: x.startTs,
    endTs: x.endTs,
    deadlineTs: x.deadlineTs,
    depositAmount: BigInt(x.depositAmount ?? '0'),
    feeLamports: BigInt(x.feeLamports ?? '0'),
    capacity: x.capacity ?? 0,
    participants: x.participants ?? 0,
    status: x.status ?? 'scheduled',
    isTest: x.isTest === true,
  };
}

const views = (docs: FirebaseFirestoreTypes.DocumentSnapshot[]) =>
  docs.map(toView).filter((c): c is CohortView => c !== null && c.status !== 'closed');

/** Every cohort that is not closed yet, oldest start first. Pass the session's dataAddress. */
export function useCohorts(dataAddress: string | null) {
  const [real, setReal] = useState<CohortView[]>([]);
  const [test, setTest] = useState<CohortView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = getFirestore(getApp());
    // The rules allow this read only with the isTest filter (rules are not filters).
    return onSnapshot(
      query(collection(db, 'cohorts'), where('isTest', '==', false)),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) => {
        setReal(views(snap.docs));
        setLoading(false);
      },
      e => {
        console.log('cohorts read failed:', e?.message ?? e);
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    setTest([]);
    if (!dataAddress) return;
    const db = getFirestore(getApp());
    let cancelled = false;
    let unsub: (() => void) | undefined;
    getDoc(doc(db, 'config', 'testers'))
      .then(snap => {
        const wallets: unknown = snap.data()?.wallets;
        if (cancelled || !Array.isArray(wallets) || !wallets.includes(dataAddress)) return;
        unsub = onSnapshot(
          query(collection(db, 'cohorts'), where('isTest', '==', true)),
          (s: FirebaseFirestoreTypes.QuerySnapshot) => setTest(views(s.docs)),
          e => console.log('test cohorts read failed:', e?.message ?? e),
        );
      })
      .catch(e => console.log('config/testers read failed:', e?.message ?? e));
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [dataAddress]);

  const cohorts = [...real, ...test].sort((a, b) => a.startTs - b.startTs);
  return { cohorts, loading };
}

/** One cohort by document id; null when missing or not readable (a test cohort for non-testers). */
export function useCohort(key: string) {
  const [cohort, setCohort] = useState<CohortView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setCohort(null);
    if (!key) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const db = getFirestore(getApp());
    return onSnapshot(
      doc(db, 'cohorts', key),
      snap => {
        setCohort(toView(snap));
        setLoading(false);
      },
      e => {
        console.log('cohort read failed:', e?.message ?? e);
        setLoading(false);
      },
    );
  }, [key]);

  return { cohort, loading };
}
