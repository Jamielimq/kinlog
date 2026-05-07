import { getApp } from '@react-native-firebase/app';
import {
  collection,
  FirebaseFirestoreTypes,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  where,
} from '@react-native-firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { elapsedDays } from './challengeProgress';

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
  // View-layer status overlay: 'active' instances past their window
  // surface as 'failed' here (idle expiration). Firestore status remains
  // the source of truth and re-syncs on the next workout. Writes that
  // gate on status (claim) MUST read instance.status, not this.
  effectiveStatus: UserChallengeStatus | null;
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

// Idle-expiration overlay: 'active' instances that have outlived their
// window surface as 'failed' to the UI. We do NOT promote 'active' to
// 'completed' even if metCount >= req — that path is essentially
// unreachable after (f), and showing Claim while Firestore is 'active'
// would let users click into a guard-rejected claim.
function deriveEffectiveStatus(
  instance: UserChallengeInstance | null,
  now: number,
): UserChallengeStatus | null {
  if (!instance) return null;
  if (instance.status !== 'active') return instance.status;
  const req = instance.requirementSnapshot.requirementDays;
  if (elapsedDays(instance.startedAt, now) <= req - 1) return 'active';
  return 'failed';
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
    const unsubscribe = onSnapshot(q, (snap: FirebaseFirestoreTypes.QuerySnapshot) => {
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
    const unsubscribe = onSnapshot(ref, (snap: FirebaseFirestoreTypes.QuerySnapshot) => {
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
    const now = Date.now();
    return catalog.map(c => {
      const forThis = instances.filter(i => i.challengeId === c.id);
      const instance = pickCurrentInstance(forThis);
      const effectiveStatus = deriveEffectiveStatus(instance, now);
      const isStartable =
        !instance || effectiveStatus === 'claimed' || effectiveStatus === 'failed';

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

      return { catalog: c, instance, effectiveStatus, isStartable, daysRemaining, progressPct };
    });
  }, [catalog, instances]);

  return {
    challenges,
    loading: catalogLoading || (!!address && instancesLoading),
  };
}
