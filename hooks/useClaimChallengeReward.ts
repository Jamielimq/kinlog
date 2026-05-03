// useClaimChallengeReward — Phase B last hook.
//
// Path A: SystemProgram.transfer to treasury + memo (no Metaplex NFT mint).
// Mirrors badges.tsx::handleMint pattern exactly.
//
// Sustainable economic model: 0.001 SOL/claim = operator revenue.
// On-chain memo audit trail serves as verifiable claim proof.
//
// Phase 3 roadmap: cNFT migration via Bubblegum
// (~$420 for 100K NFTs, sustained from Phase 1 revenue).
// All claim data (wallet address, tx signature, requirement snapshot)
// preserved for automatic future cNFT migration.
//
// Memo format: kinlog:claim:{challengeId}:{instanceId}:{sequence}

import { getApp } from '@react-native-firebase/app';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getFirestore,
  increment,
  setDoc,
} from '@react-native-firebase/firestore';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from '@solana/web3.js';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useWallet } from '../context/WalletContext';
import type { ChallengeView, UserChallengeInstance } from './useChallenges';

const TREASURY_WALLET = new PublicKey(
  'EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ',
);
const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

export function useClaimChallengeReward() {
  const { publicKey, authorizeAndSign } = useWallet();
  const [isClaiming, setIsClaiming] = useState(false);

  const claimChallengeReward = useCallback(
    async (
      view: ChallengeView,
    ): Promise<{ txSignature: string; awardedPoints: number }> => {
      setIsClaiming(true);
      try {
        const address = publicKey?.toBase58() ?? null;
        if (!address || !publicKey) {
          throw new Error('Wallet not connected.');
        }

        const instance = view.instance;
        if (!instance) {
          throw new Error('No challenge instance to claim.');
        }
        if (instance.status !== 'completed') {
          throw new Error('Challenge is not in claimable state.');
        }

        const db = getFirestore(getApp());
        const instanceRef = doc(
          db,
          'users',
          address,
          'userChallenges',
          instance.id,
        );

        // Fresh read — guard against stale view
        // (e.g., already claimed on another device).
        const freshSnap = await getDoc(instanceRef);
        const fresh = freshSnap.data() as
          | Omit<UserChallengeInstance, 'id'>
          | undefined;
        if (!fresh || fresh.status !== 'completed') {
          throw new Error('Challenge is not in claimable state.');
        }

        // bonusPoints comes from LIVE catalog — claimedTransitionValid rule
        // compares against challenges/{id}.bonusPoints, not the snapshot.
        const awardedPoints = view.catalog.bonusPoints;

        const memo = `kinlog:claim:${view.catalog.id}:${instance.id}:${instance.sequence}`;
        const lamports = instance.requirementSnapshot.mintFeeLamports;

        // On-chain: SystemProgram.transfer + Memo (single tx, 2 instructions).
        let txSignature = '';
        await authorizeAndSign(async wallet => {
          const conn = new Connection(
            clusterApiUrl('mainnet-beta'),
            'confirmed',
          );
          const { blockhash } = await conn.getLatestBlockhash();

          const tx = new Transaction();
          tx.recentBlockhash = blockhash;
          tx.feePayer = publicKey;
          tx.add(
            SystemProgram.transfer({
              fromPubkey: publicKey,
              toPubkey: TREASURY_WALLET,
              lamports,
            }),
          );
          tx.add(
            new TransactionInstruction({
              keys: [],
              programId: MEMO_PROGRAM_ID,
              data: Buffer.from(memo, 'utf8'),
            }),
          );

          const signatures = await wallet.signAndSendTransactions({
            transactions: [tx],
          });
          txSignature = signatures[0];
        });

        if (!txSignature) {
          throw new Error('No transaction signature returned.');
        }

        const now = Date.now();

        // Firestore claim write — must succeed for the claim to be recorded.
        // Phase 3 cNFT migration prep: nftMint/migratedAt/migrationVersion reserved.
        try {
          await setDoc(
            instanceRef,
            {
              status: 'claimed',
              claimedAt: now,
              bonusPointsAwarded: awardedPoints,
              claimTxSignature: txSignature,
              nftMint: null,
              migratedAt: null,
              migrationVersion: 1,
            },
            { merge: true },
          );
        } catch (fsError: any) {
          console.error(
            'Firestore claim write failed (tx already confirmed):',
            fsError,
            'tx:',
            txSignature,
          );
          throw new Error(
            `Recorded on-chain (tx: ${txSignature}) but local update failed: ${fsError?.message ?? 'Unknown error'}. Reach out with the tx signature.`,
          );
        }

        // Best-effort points award — claim already succeeded; this is bookkeeping.
        try {
          await setDoc(
            doc(db, 'users', address),
            { points: increment(awardedPoints), updatedAt: now },
            { merge: true },
          );
          await addDoc(collection(db, 'users', address, 'points_history'), {
            reason: `Claimed quest: ${view.catalog.name}`,
            amount: awardedPoints,
            createdAt: now,
          });
        } catch (pointsError) {
          console.error('Points award failed (non-fatal):', pointsError);
        }

        return { txSignature, awardedPoints };
      } catch (e: any) {
        const msg = e?.message ?? '';
        const isCancel =
          msg.includes('CancellationException') || msg.includes('cancelled');
        if (!isCancel) {
          console.error('Claim challenge reward error:', e);
          Alert.alert(
            'Could not claim reward',
            msg || 'Something went wrong. Please try again.',
          );
        }
        throw e;
      } finally {
        setIsClaiming(false);
      }
    },
    [publicKey, authorizeAndSign],
  );

  return { claimChallengeReward, isClaiming };
}
