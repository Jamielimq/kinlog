import { getApp } from '@react-native-firebase/app';
import { doc, getDoc, getFirestore, setDoc } from '@react-native-firebase/firestore';
import { Connection, PublicKey } from '@solana/web3.js';
import { useEffect, useState } from 'react';

const HELIUS_API_KEY = process.env.EXPO_PUBLIC_HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const STAKING_PROGRAM = new PublicKey('SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ');
const STAKE_CONFIG = '4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw';
const PROGRAM_ID = 'SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ';
const MIN_STAKED = 1;

// Find stake PDA from Helius transaction history
async function findPDAFromTransactions(walletAddress: string): Promise<string | null> {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
    const res = await fetch(url);
    const txs = await res.json();

    for (const tx of txs) {
      for (const ix of tx.instructions || []) {
        if (ix.programId === PROGRAM_ID && ix.accounts?.length > 0) {
          return ix.accounts[0];
        }
      }
      for (const inner of tx.innerInstructions || []) {
        for (const ix of inner.instructions || []) {
          if (ix.programId === PROGRAM_ID && ix.accounts?.length > 0) {
            return ix.accounts[0];
          }
        }
      }
    }
    return null;
  } catch (e: any) {
    console.log('SKR: Transaction search error:', e?.message?.slice(0, 100));
    return null;
  }
}

export function useSkrStaking(address: string | null) {
  const [stakedAmount, setStakedAmount] = useState(0);
  const [isStaker, setIsStaker] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setStakedAmount(0);
      setIsStaker(false);
      return;
    }

    const check = async () => {
      setLoading(true);
      try {
        if (!HELIUS_API_KEY) {
          throw new Error(
            'Missing EXPO_PUBLIC_HELIUS_API_KEY. Add it to a local .env file (see .env.example).'
          );
        }
        const connection = new Connection(HELIUS_RPC, 'confirmed');
        const db = getFirestore(getApp());

        // 1. Get sharePrice from config account
        const cfgInfo = await connection.getAccountInfo(new PublicKey(STAKE_CONFIG));
        if (!cfgInfo) { console.log('SKR: Config not found'); return; }
        const sharePrice = Number(cfgInfo.data.readBigUInt64LE(137));

        // 2. Check Firebase cache first
        const cacheRef = doc(db, 'users', address, 'cache', 'skr_staking');
        const cacheSnap = await getDoc(cacheRef);
        const cachedAccount = cacheSnap.data()?.stakeAccount;

        let stakeAccountData = null;
        let foundAddress = '';

        if (cachedAccount) {
          console.log('SKR: Using cached account:', cachedAccount);
          const info = await connection.getAccountInfo(new PublicKey(cachedAccount));
          if (info && info.data.length === 169) {
            stakeAccountData = info.data;
          }
        }

        // 3. If no cache, try Helius transaction API (reliable)
        if (!stakeAccountData) {
          console.log('SKR: Searching via transaction history...');
          const pda = await findPDAFromTransactions(address);
          if (pda) {
            console.log('SKR: Found PDA from transactions:', pda);
            const info = await connection.getAccountInfo(new PublicKey(pda));
            if (info && info.data.length === 169) {
              stakeAccountData = info.data;
              foundAddress = pda;
            }
          }
        }

        // 4. Last resort: getProgramAccounts with retry
        if (!stakeAccountData) {
          console.log('SKR: Trying getProgramAccounts...');
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const accounts = await connection.getProgramAccounts(STAKING_PROGRAM, {
                filters: [
                  { dataSize: 169 },
                  { memcmp: { offset: 41, bytes: address } },
                ],
              });
              if (accounts.length > 0) {
                stakeAccountData = accounts[0].account.data;
                foundAddress = accounts[0].pubkey.toBase58();
                console.log('SKR: Found via getProgramAccounts on attempt', attempt);
                break;
              }
            } catch (e: any) {
              console.log('SKR: Attempt', attempt, 'error');
            }
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }

        // 5. Cache the found address
        if (foundAddress) {
          await setDoc(cacheRef, { stakeAccount: foundAddress, updatedAt: Date.now() }, { merge: true });
        }

        // 6. Calculate staked amount
        if (stakeAccountData) {
          const shares = Number(stakeAccountData.readBigUInt64LE(104));
          const skr = shares * sharePrice / 1e15 / 256;
          const rounded = Math.round(skr * 100) / 100;
          console.log('SKR total staked:', rounded);
          setStakedAmount(rounded);
          setIsStaker(rounded >= MIN_STAKED);
        } else {
          console.log('SKR: No stake account found');
          setStakedAmount(0);
          setIsStaker(false);
        }
      } catch (e: any) {
        console.log('SKR check error:', e?.message);
        setIsStaker(false);
      } finally {
        setLoading(false);
      }
    };

    check();
  }, [address]);

  return { stakedAmount, isStaker, loading };
}
