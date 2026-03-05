import { getApp } from '@react-native-firebase/app';
import { getFirestore, collection, query, orderBy, limit, onSnapshot, doc, getDoc, setDoc } from '@react-native-firebase/firestore';
import { useState, useEffect } from 'react';

export interface LeaderboardEntry {
  address: string;
  score: number;
  updatedAt: number;
}

export function useLeaderboard(gameId: string = '2048') {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = getFirestore(getApp());
    const q = query(
      collection(db, 'leaderboard', gameId, 'scores'),
      orderBy('score', 'desc'),
      limit(20)
    );
    const unsubscribe = onSnapshot(q, snapshot => {
      const data = snapshot?.docs?.map(d => d.data() as LeaderboardEntry) ?? [];
      setEntries(data);
      setLoading(false);
    });
    return unsubscribe;
  }, [gameId]);

  const submitScore = async (address: string, score: number) => {
    const db = getFirestore(getApp());
    const ref = doc(db, 'leaderboard', gameId, 'scores', address);
    const snap = await getDoc(ref);
    if (!snap.exists() || (snap.data()?.score ?? 0) < score) {
      await setDoc(ref, { address, score, updatedAt: Date.now() });
      return true;
    }
    return false;
  };

  return { entries, loading, submitScore };
}