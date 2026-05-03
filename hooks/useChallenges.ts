import { getApp } from '@react-native-firebase/app';
import {
  collection,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  where,
} from '@react-native-firebase/firestore';
import { useEffect, useMemo, useState } from 'react';

// ───────────────────────────────────────────────────────────────
// Catalog: challenges/{challengeId}
// ───────────────────────────────────────────────────────────────

export interface ChallengeNFTMetadata {
  symbol: string;
  uriTemplate: string;
  gradientFrom: string;
  gradientTo: string;
  romanNumeral: string;
}

export interface ChallengeCatalog {
  id: string;
  name: string;
  tagline: string;
  description: string;
  requirementType: string;
  requirementDays: number;
  requirementDailyReps: number;
  bonusPoints: number;
  mintFeeLamports: number;
  rarity: string;
  nft: ChallengeNFTMetadata;
  isActive: boolean;
  displayOrder: number;
  createdAt: number;
}

// ───────────────────────────────────────────────────────────────
// User instance: users/{wallet}/userChallenges/{instanceId}
// ───────────────────────────────────────────────────────────────

export type UserChallengeStatus = 'active' | 'completed' | 'failed' | 'claimed';

export interface UserChallengeRequirementSnapshot {
  requirementType: string;
  requirementDays: number;
  requirementDailyReps: number;
  bonusPoints: number;
  mintFeeLamports: number;
}

export interface UserChallengeProgress {
  dayIndex: number; // 1..requirementDays — days elapsed since startedAt + 1
  daysLog: Record<string, { reps: number; met: boolean }>;
  lastProgressDate: string; // 'YYYY-MM-DD' (local)
}

export interface UserChallengeInstance {
  id: string;
  challengeId: string;
  status: UserChallengeStatus;
  sequence: number;
  startedAt: number;
  startTxSignature: string;
  startMemo: string;
  requirementSnapshot: UserChallengeRequirementSnapshot;
  progress: UserChallengeProgress;
  completedAt?: number;
  failedAt?: number;
  claimedAt?: number;
  bonusPointsAwarded?: number;
  claimTxSignature?: string;
}

// ───────────────────────────────────────────────────────────────
// Merged view returned to the UI
// ───────────────────────────────────────────────────────────────

export interface ChallengeView {
  catalog: ChallengeCatalog;
  instance: UserChallengeInstance | null;
  isStartable: boolean;
  daysRemaining: number | null;
  progressPct: number; // 0..1
}

// active > completed (claim-pending) > most-recent terminal (claimed | failed)
function pickCurrentInstance(
  list: UserChallengeInstance[],
): UserChallengeInstance | null {
  if (list.length === 0) return null;
  const rank = (s: UserChallengeStatus) =>
    s === 'active' ? 3 : s === 'completed' ? 2 : 1;
  return list.slice().sort((a, b) => {
    const r = rank(b.status) - rank(a.status);
    return r !== 0 ? r : b.sequence - a.sequence;
  })[0];
}

export function useChallenges(address: string | null) {
  const [catalog, setCatalog] = useState<ChallengeCatalog[]>([]);
  const [instances, setInstances] = useState<UserChallengeInstance[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [instancesLoading, setInstancesLoading] = useState(true);

  // Catalog: global, address-independent
  useEffect(() => {
    const db = getFirestore(getApp());
    const q = query(
      collection(db, 'challenges'),
      where('isActive', '==', true),
      orderBy('displayOrder', 'asc'),
    );
    const unsubscribe = onSnapshot(q, snap => {
      setCatalog(
        snap.docs.map(d => ({
          ...(d.data() as Omit<ChallengeCatalog, 'id'>),
          id: d.id,
        })),
      );
      setCatalogLoading(false);
    });
    return unsubscribe;
  }, []);

  // User instances
  useEffect(() => {
    if (!address) {
      setInstances([]);
      setInstancesLoading(false);
      return;
    }
    const db = getFirestore(getApp());
    const ref = collection(db, 'users', address, 'userChallenges');
    const unsubscribe = onSnapshot(ref, snap => {
      setInstances(
        snap.docs.map(d => ({
          ...(d.data() as Omit<UserChallengeInstance, 'id'>),
          id: d.id,
        })),
      );
      setInstancesLoading(false);
    });
    return unsubscribe;
  }, [address]);

  const challenges = useMemo<ChallengeView[]>(() => {
    return catalog.map(c => {
      const forThis = instances.filter(i => i.challengeId === c.id);
      const instance = pickCurrentInstance(forThis);
      const isStartable =
        !instance || instance.status === 'claimed' || instance.status === 'failed';

      let progressPct = 0;
      let daysRemaining: number | null = null;
      if (instance) {
        const req = instance.requirementSnapshot.requirementDays;
        const metCount = Object.values(instance.progress.daysLog ?? {}).filter(
          d => d.met,
        ).length;
        progressPct = req > 0 ? Math.min(1, metCount / req) : 0;
        daysRemaining = Math.max(0, req - metCount);
      }

      return { catalog: c, instance, isStartable, daysRemaining, progressPct };
    });
  }, [catalog, instances]);

  return {
    challenges,
    loading: catalogLoading || (!!address && instancesLoading),
  };
}
