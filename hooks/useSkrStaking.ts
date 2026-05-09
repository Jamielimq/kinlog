import { getApp } from '@react-native-firebase/app';
import { deleteDoc, doc, getFirestore } from '@react-native-firebase/firestore';
import { Connection, PublicKey } from '@solana/web3.js';
import { useEffect, useState } from 'react';

const HELIUS_API_KEY = process.env.EXPO_PUBLIC_HELIUS_API_KEY;
const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

const STAKING_PROGRAM = new PublicKey('SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ');
const STAKE_CONFIG = new PublicKey('4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw');
const GUARDIAN_POOL = new PublicKey('DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr');

// Account layouts (with 8-byte Anchor discriminator).
// UserStake (169 B):   bump(1) | stake_config(32) | user(32) | guardian_pool(32) | shares(u128) | ...
// StakeConfig (193 B): bump(1) | authority(32) | mint(32) | stake_vault(32) | min_stake(u64)
//                    | cooldown(u64) | total_shares(u128) | share_price(u128) | ...
const USERSTAKE_SHARES_OFFSET = 105; // 8 + 1 + 32 + 32 + 32
const STAKECONFIG_SHARE_PRICE_OFFSET = 137; // 8 + 1 + 32 + 32 + 32 + 8 + 8 + 16

const SHARE_PRICE_SCALE = 1_000_000_000n; // u128 scale used by SKR program
const SKR_DECIMALS_POW = 1_000_000n; // SKR has 6 decimals
const MIN_STAKED = 1;

function readU128LE(buf: Buffer, off: number): bigint {
  const lo = buf.readBigUInt64LE(off);
  const hi = buf.readBigUInt64LE(off + 8);
  return (hi << 64n) | lo;
}

function deriveUserStakePda(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('user_stake'),
      STAKE_CONFIG.toBuffer(),
      user.toBuffer(),
      GUARDIAN_POOL.toBuffer(),
    ],
    STAKING_PROGRAM,
  );
  return pda;
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

    let cancelled = false;
    const check = async () => {
      setLoading(true);
      try {
        const connection = new Connection(RPC_URL, 'confirmed');
        const user = new PublicKey(address);
        const pda = deriveUserStakePda(user);

        const [pdaInfo, configInfo] = await Promise.all([
          connection.getAccountInfo(pda),
          connection.getAccountInfo(STAKE_CONFIG),
        ]);
        if (cancelled) return;

        if (!pdaInfo || pdaInfo.data.length !== 169) {
          setStakedAmount(0);
          setIsStaker(false);
          return;
        }
        if (!configInfo) {
          console.log('SKR: StakeConfig not found');
          return;
        }

        const shares = readU128LE(pdaInfo.data, USERSTAKE_SHARES_OFFSET);
        const sharePrice = readU128LE(configInfo.data, STAKECONFIG_SHARE_PRICE_OFFSET);
        const rawTokens = (shares * sharePrice) / SHARE_PRICE_SCALE;
        const skr = Number(rawTokens) / Number(SKR_DECIMALS_POW);
        const rounded = Math.round(skr * 100) / 100;

        setStakedAmount(rounded);
        setIsStaker(rounded >= MIN_STAKED);
      } catch (e: any) {
        if (!cancelled) {
          console.log('SKR check error:', e?.message);
          setIsStaker(false);
        }
      } finally {
        // Drain the legacy `cache/skr_staking` doc — new path never reads it.
        // Silent fail: rules denial or already-absent both leave us correct.
        try {
          const db = getFirestore(getApp());
          await deleteDoc(doc(db, 'users', address, 'cache', 'skr_staking'));
        } catch {
          // ignore
        }
        if (!cancelled) setLoading(false);
      }
    };

    check();
    return () => {
      cancelled = true;
    };
  }, [address]);

  return { stakedAmount, isStaker, loading };
}
