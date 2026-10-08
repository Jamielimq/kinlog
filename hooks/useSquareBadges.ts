import { getApp } from '@react-native-firebase/app';
import { collection, FirebaseFirestoreTypes, getFirestore, onSnapshot, query, where } from '@react-native-firebase/firestore';
import { useEffect, useState } from 'react';
import { SQUARE_BADGES } from '../lib/squareBadges';

/** users/{wallet}/badges/<squareId>_<cohort>: one Square badge from one cohort, written when claimed. */
export interface SquareBadgeRecord {
  kind: 'square';
  badge: string;
  cohort: string;
  claimed: boolean;
  claimedAt?: number;
  txSignature?: string;
}

/**
 * This wallet's Square badges: the cohorts each was earned in, from the server's grants
 * (users/{wallet}/badges/<id>/grants/<cohort>, readable by the signed-in owner only), and the claim
 * records by id. Each is null until read. Pass the session's dataAddress.
 */
export function useSquareBadges(address: string | null) {
  const [grants, setGrants] = useState<Map<string, string[]> | null>(null);
  const [records, setRecords] = useState<Map<string, SquareBadgeRecord> | null>(null);

  useEffect(() => {
    setGrants(null);
    if (!address) return;
    const db = getFirestore(getApp());
    const got = new Map<string, string[]>();
    const put = (id: string, cohorts: string[]) => {
      got.set(id, cohorts);
      // Ready once every badge has answered, so none shows Locked only because it hasn't yet.
      if (got.size === SQUARE_BADGES.length) setGrants(new Map(got));
    };
    const unsubs = SQUARE_BADGES.map(b =>
      onSnapshot(
        collection(db, 'users', address, 'badges', b.id, 'grants'),
        (snap: FirebaseFirestoreTypes.QuerySnapshot) => put(b.id, snap.docs.map(d => d.id).sort()),
        e => {
          console.log(`${b.id} grants read failed:`, e?.message ?? e);
          put(b.id, []);
        },
      ),
    );
    return () => unsubs.forEach(u => u());
  }, [address]);

  useEffect(() => {
    setRecords(null);
    if (!address) return;
    const db = getFirestore(getApp());
    return onSnapshot(
      query(collection(db, 'users', address, 'badges'), where('kind', '==', 'square')),
      (snap: FirebaseFirestoreTypes.QuerySnapshot) =>
        setRecords(new Map(snap.docs.map(d => [d.id, d.data() as SquareBadgeRecord]))),
      e => console.log('square badge records read failed:', e?.message ?? e),
    );
  }, [address]);

  return { grants, records };
}
