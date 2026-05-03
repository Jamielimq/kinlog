// challengeId convention: [a-z0-9_]+ only.
// Memo format: kinlog:start:{challengeId}:{timestamp}:{sequence}
// Designed for parseable on-chain audit trail.

import { getApp } from '@react-native-firebase/app';
import {
  addDoc,
  collection,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  where,
} from '@react-native-firebase/firestore';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  clusterApiUrl,
} from '@solana/web3.js';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { useWallet } from '../context/WalletContext';
import type {
  ChallengeCatalog,
  UserChallengeInstance,
} from './useChallenges';

const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

export function useStartChallenge() {
  const { publicKey, authorizeAndSign } = useWallet();
  const [isStarting, setIsStarting] = useState(false);

  const startChallenge = useCallback(
    async (
      catalog: ChallengeCatalog,
    ): Promise<{ instanceId: string; txSignature: string }> => {
      setIsStarting(true);
      try {
        const address = publicKey?.toBase58() ?? null;
        if (!address || !publicKey) {
          throw new Error('Wallet not connected.');
        }

        const db = getFirestore(getApp());

        // Active/completed guard + sequence calculation in one query.
        // Index: (challengeId ASC, sequence DESC).
        const lastSnap = await getDocs(
          query(
            collection(db, 'users', address, 'userChallenges'),
            where('challengeId', '==', catalog.id),
            orderBy('sequence', 'desc'),
            limit(1),
          ),
        );

        let nextSequence = 1;
        if (!lastSnap.empty) {
          const last = lastSnap.docs[0].data() as UserChallengeInstance;
          if (last.status === 'active' || last.status === 'completed') {
            throw new Error('This challenge is already in progress.');
          }
          nextSequence = (last.sequence ?? 0) + 1;
        }

        const startedAt = Date.now();
        const memo = `kinlog:start:${catalog.id}:${startedAt}:${nextSequence}`;

        // On-chain memo transaction (base tx fee only — no transfer).
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

        // Firestore write only after on-chain success.
        const instance: Omit<UserChallengeInstance, 'id'> = {
          challengeId: catalog.id,
          status: 'active',
          sequence: nextSequence,
          startedAt,
          startTxSignature: txSignature,
          startMemo: memo,
          requirementSnapshot: {
            requirementType: catalog.requirementType,
            requirementDays: catalog.requirementDays,
            requirementDailyReps: catalog.requirementDailyReps,
            bonusPoints: catalog.bonusPoints,
            mintFeeLamports: catalog.mintFeeLamports,
          },
          progress: {
            dayIndex: 0,
            daysLog: {},
            lastProgressDate: '',
          },
        };

        const ref = await addDoc(
          collection(db, 'users', address, 'userChallenges'),
          instance,
        );

        return { instanceId: ref.id, txSignature };
      } catch (e: any) {
        const msg = e?.message ?? '';
        const isCancel =
          msg.includes('CancellationException') || msg.includes('cancelled');
        if (!isCancel) {
          console.error('Start challenge error:', e);
          Alert.alert(
            'Could not start challenge',
            msg || 'Something went wrong. Please try again.',
          );
        }
        throw e;
      } finally {
        setIsStarting(false);
      }
    },
    [publicKey, authorizeAndSign],
  );

  return { startChallenge, isStarting };
}
