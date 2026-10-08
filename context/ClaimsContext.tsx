import { getApp } from '@react-native-firebase/app';
import { doc, getFirestore, increment, runTransaction } from '@react-native-firebase/firestore';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Popup, type PopupAction } from '../components/Popup';
import { useBadges } from '../hooks/useBadges';
import { type MonthlyBadgeRecord, useMonthlyBadges } from '../hooks/useMonthlyBadges';
import { useSquareBadges } from '../hooks/useSquareBadges';
import { useWorkoutDays } from '../hooks/useWorkoutDays';
import {
  badgeClaimAlert,
  CLAIM_NOT_CONFIRMED,
  CLAIM_NOT_SAVED,
  claimInstructions,
  sentState,
  type SentState,
} from '../lib/badgeClaim';
import { type BadgeCard, buildCards, type SentClaimState } from '../lib/badgeCards';
import type { ClaimItem } from '../lib/claims';
import { dataLoading } from '../lib/dataLoading';
import { isWalletCancel, sendWithWallet, TxError } from '../lib/lockedIn/tx';
import { addPending, loadPending, type PendingClaim, removePending } from '../lib/pendingClaims';
import { type DateKey, goalDays } from '../lib/record';
import { getConnection } from '../lib/solana';
import { useWallet } from './WalletContext';

const RECHECK_MS = 15_000;
const SAVE_TRIES = 3;
const OK_ONLY: PopupAction[] = [{ label: 'OK', primary: true }];

/**
 * Records a confirmed claim and its points in one transaction: the badge record, its points_history
 * entry (a fixed id) and the cached total on users/{wallet}. If the record already says claimed
 * (mintedAt, for a lifetime badge), nothing is written, so a retry or a second device can't add the
 * points twice.
 */
async function recordClaim(address: string, c: ClaimItem & { signature: string }) {
  const db = getFirestore(getApp());
  const badgeRef = doc(db, 'users', address, 'badges', c.id);
  await runTransaction(db, async tx => {
    const snap = await tx.get(badgeRef);
    const prev = snap.exists() ? snap.data() : undefined;
    if (c.kind === 'lifetime' ? prev?.mintedAt : prev?.claimed === true) return;
    const now = Date.now();
    tx.set(
      badgeRef,
      c.kind === 'lifetime'
        ? // The fields a lifetime claim has always written, which useBadges and v1.3.3 read.
          { mintedAt: now, txSignature: c.signature, memo: c.memo }
        : { kind: c.kind, ...c.fields, earned: true, claimed: true, claimedAt: now, txSignature: c.signature, memo: c.memo, pts: c.pts },
      { merge: true },
    );
    if (c.pts > 0) {
      tx.set(doc(db, 'users', address, 'points_history', c.pointsId), { reason: c.reason, amount: c.pts, createdAt: now });
      tx.set(doc(db, 'users', address), { points: increment(c.pts), updatedAt: now }, { merge: true });
    }
  });
}

interface ClaimsContextType {
  /** Every badge card (lib/badgeCards.ts), in catalog order. */
  cards: BadgeCard[];
  /**
   * While a connected wallet's workouts, badge records and claims kept on the phone aren't all read,
   * before sign-in too (lib/dataLoading.ts): nothing can be claimed, and nothing shows
   * Locked, Claim or a count.
   */
  loading: boolean;
  /** Cards with a claim open now: the red dots. */
  readyCount: number;
  /** The record id of the claim under way; one at a time, from either tab. */
  claimingId: string | null;
  /** Claims for 0.001 SOL. A success only changes the card; a claim that doesn't go through gets a popup. */
  claim: (item: ClaimItem) => Promise<void>;
  /** Looks at the claims kept on the phone again and settles what the chain can tell. */
  recheck: () => Promise<void>;
  // The record Goals draws, from the same reads.
  totals: Map<DateKey, number>;
  days: Set<DateKey>;
  today: DateKey;
  monthly: Map<string, MonthlyBadgeRecord> | null;
  sent: Map<string, SentClaimState> | null;
}

const ClaimsContext = createContext<ClaimsContextType | null>(null);

/**
 * Badge claims for both Goals and Badges, so a badge looks and claims the same from either tab: every
 * kind (lifetime, monthly, Square) pays the same way (lib/badgeClaim.ts) and is recorded the same
 * way (recordClaim). A sent claim is kept on the phone from the moment the wallet sends it
 * (lib/pendingClaims.ts); confirmed ones are recorded, failed or expired ones dropped, and the rest
 * checked again when either tab is opened and every 15 seconds while any remain. Pass nothing: it
 * follows the session's wallet, and a change of wallet drops whatever was under way for the old one.
 */
export function ClaimsProvider({ children }: { children: ReactNode }) {
  const { publicKey, dataAddress, authorizeAndSign } = useWallet();
  const { totals, today, loading: workoutsLoading } = useWorkoutDays(dataAddress);
  const days = goalDays(totals);
  const { badges, loading: badgesLoading } = useBadges(dataAddress);
  const monthly = useMonthlyBadges(dataAddress, days, today);
  const { grants, records: square } = useSquareBadges(dataAddress);
  const [sent, setSent] = useState<Map<string, SentClaimState> | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  // Set on the tap itself: state only changes on the next render, which a fast second tap can beat.
  const claimingRef = useRef(false);
  // The wallet whose claims are shown. A check or a claim for any other leaves `sent` alone.
  const addressRef = useRef(dataAddress);
  // The check under way and whose: a second call for the same wallet joins it, and a new wallet's
  // check starts at once instead of being skipped while the old one's finishes.
  const checkRef = useRef<{ address: string; run: Promise<void> } | null>(null);
  // The popup's content stays while it fades out, so closing only clears noticeOpen.
  const [notice, setNotice] = useState<{ title: string; body: string } | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const showNotice = (n: { title: string; body: string }) => {
    setNotice(n);
    setNoticeOpen(true);
  };

  const loading = dataLoading(
    !!publicKey,
    dataAddress,
    workoutsLoading || badgesLoading || monthly === null || grants === null || square === null || sent === null,
  );
  const cards = buildCards({ loading, lifetime: badges, days, today, monthly, grants, square, sent });
  const readyCount = cards.filter(c => c.state === 'ready').length;

  // Changes to the claims shown, for the wallet they belong to only, and never before they're read.
  const mark = (address: string, id: string, state: SentClaimState) => {
    if (addressRef.current === address) setSent(prev => prev && new Map(prev).set(id, state));
  };
  const unmark = (address: string, id: string) => {
    if (addressRef.current !== address) return;
    setSent(prev => {
      if (!prev) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const recheck = useCallback((): Promise<void> => {
    const address = addressRef.current;
    if (!address) return Promise.resolve();
    if (checkRef.current?.address === address) return checkRef.current.run;
    const run: Promise<void> = (async () => {
      try {
        const connection = getConnection();
        const outcome = new Map<string, SentClaimState>(); // by signature
        const saved: string[] = []; // ids recorded by this run, shown claimed until their records come back
        for (const p of await loadPending(address)) {
          // Another wallet now: its results would be the wrong wallet's. This one is checked again when it's back.
          if (addressRef.current !== address) return;
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
              saved.push(p.id);
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
        const kept = await loadPending(address);
        if (addressRef.current === address) {
          setSent(
            new Map<string, SentClaimState>([
              ...saved.map(id => [id, 'saved'] as const),
              ...kept.map(p => [p.id, outcome.get(p.signature) ?? 'checking'] as const),
            ]),
          );
        }
      } catch (e: any) {
        console.log('sent claims check failed:', e?.message ?? e);
      }
    })().finally(() => {
      if (checkRef.current?.run === run) checkRef.current = null;
    });
    checkRef.current = { address, run };
    return run;
  }, []);

  useEffect(() => {
    addressRef.current = dataAddress;
    setSent(null);
    if (dataAddress) void recheck();
  }, [dataAddress, recheck]);

  const remaining = sent?.size ?? 0;
  useEffect(() => {
    if (!remaining) return;
    const t = setInterval(() => void recheck(), RECHECK_MS);
    return () => clearInterval(t);
  }, [remaining, recheck]);

  /** Off the phone. Still kept if that fails: recheck then finds it recorded (or failed) and removes it. */
  const drop = async (address: string, p: PendingClaim) => {
    try {
      await removePending(address, p.signature);
    } catch (e: any) {
      console.log('pending claim removal failed:', e?.message ?? e);
    }
  };

  /** Confirmed: record it (a few tries). False when it couldn't be saved; recheck keeps trying. */
  const settle = async (address: string, p: PendingClaim): Promise<boolean> => {
    for (let i = 0; i < SAVE_TRIES; i++) {
      try {
        await recordClaim(address, p);
        // Claimed from now on, even before the record's listener catches up (then a stale card
        // would offer Claim now for a moment).
        mark(address, p.id, 'saved');
        await drop(address, p);
        return true;
      } catch (e: any) {
        console.log('claim save failed:', e?.message ?? e);
      }
    }
    mark(address, p.id, 'unsaved');
    return false;
  };

  const claim = async (item: ClaimItem) => {
    const address = dataAddress;
    // Only a claim a card offers right now, so a stale tap can't pay twice.
    const open = cards.some(c => c.open.some(i => i.id === item.id));
    if (claimingRef.current || loading || !publicKey || !address || !open) return;
    claimingRef.current = true;
    setClaimingId(item.id);
    // Set by onSent: from then on the payment may go through whatever happens here.
    const kept: { claim: PendingClaim | null } = { claim: null };
    try {
      const signature = await sendWithWallet({
        connection: getConnection(),
        payer: publicKey,
        instructions: claimInstructions(publicKey, item.memo),
        authorizeAndSign,
        onSent: async (sig, lastValidBlockHeight) => {
          kept.claim = { ...item, signature: sig, lastValidBlockHeight, sentAt: Date.now() };
          // Kept on the phone before anything else can go wrong.
          await addPending(address, kept.claim);
          mark(address, item.id, 'checking');
        },
      });
      // Confirmed. The card changes on its own; only a claim that couldn't be saved yet is told.
      const p = kept.claim ?? { ...item, signature, lastValidBlockHeight: 0, sentAt: Date.now() };
      if (!(await settle(address, p))) showNotice(CLAIM_NOT_SAVED);
    } catch (e) {
      console.log('Badge claim failed:', (e as any)?.message ?? e);
      if (isWalletCancel(e)) return;
      if (!kept.claim) {
        showNotice(badgeClaimAlert(e));
      } else if (e instanceof TxError && e.kind === 'failed') {
        // Sent, and the chain reports it failed, so the fee transfer didn't happen: claimable again.
        await drop(address, kept.claim);
        unmark(address, item.id);
        showNotice(badgeClaimAlert(e));
      } else {
        // Sent, and the outcome isn't known (expired, a wallet or network error): it stays Checking
        // for recheck to settle by searching the whole history.
        showNotice(CLAIM_NOT_CONFIRMED);
      }
    } finally {
      claimingRef.current = false;
      setClaimingId(null);
    }
  };

  const value: ClaimsContextType = {
    cards,
    loading,
    readyCount,
    claimingId,
    claim,
    recheck,
    totals,
    days,
    today,
    monthly,
    sent,
  };
  return (
    <ClaimsContext.Provider value={value}>
      {children}
      {notice && (
        <Popup
          visible={noticeOpen}
          title={notice.title}
          message={notice.body}
          actions={OK_ONLY}
          onClose={() => setNoticeOpen(false)}
        />
      )}
    </ClaimsContext.Provider>
  );
}

export function useClaims() {
  const ctx = useContext(ClaimsContext);
  if (!ctx) throw new Error('useClaims must be used inside ClaimsProvider');
  return ctx;
}
