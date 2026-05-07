import { getApp } from '@react-native-firebase/app';
import { collection, doc, FirebaseFirestoreTypes, getDoc, getDocs, getFirestore, setDoc } from '@react-native-firebase/firestore';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

interface WalletContextType {
  publicKey: PublicKey | null;
  shortAddress: string | null;
  connecting: boolean;
  // True only during the cold-start cache read. Gate Connect Wallet
  // prompts (and disable taps) before we know whether a cached session
  // exists, to suppress the brief Connect flash + reflexive taps.
  restoring: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  authorizeAndSign: (callback: (wallet: any, authToken: string) => Promise<void>) => Promise<void>;
}

const WalletContext = createContext<WalletContextType>({
  publicKey: null,
  shortAddress: null,
  connecting: false,
  restoring: true,
  connect: async () => {},
  disconnect: () => {},
  authorizeAndSign: async () => {},
});

const STORAGE_KEY = 'kinlog.wallet.session';
const KINLOG_IDENTITY = {
  name: 'Kinlog',
  uri: 'https://kinlog.app',
  icon: '/favicon.ico',
} as const;

interface CachedSession {
  address: string; // base58
  authToken: string;
}

async function loadSession(): Promise<CachedSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CachedSession) : null;
  } catch (e) {
    console.warn('Wallet session load failed:', e);
    return null;
  }
}

async function saveSession(s: CachedSession): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {
    console.warn('Wallet session save failed:', e);
  }
}

async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  } catch {}
}

async function initUserInFirestore(address: string) {
  try {
    const db = getFirestore(getApp());
    const userRef = doc(db, 'users', address);
    const snap = await getDoc(userRef);
    const data = snap.data() ?? {};
    const now = Date.now();

    // Stamp createdAt only on first connect; never overwrite stats.
    // Every write here uses merge: true so an unexpected doc shape can never
    // clobber existing fields (this was the source of the v1.1.0 reset bug).
    const stamp: { updatedAt: number; createdAt?: number } = { updatedAt: now };
    if (data.createdAt == null) stamp.createdAt = now;
    await setDoc(userRef, stamp, { merge: true });

    // Always reconcile from subcollections (source of truth). Runs for both
    // new and existing users — covers the case where parent doc was wiped or
    // partially written but workouts/points_history survived.
    try {
      const historySnap: FirebaseFirestoreTypes.QuerySnapshot =
        await getDocs(collection(db, 'users', address, 'points_history'));
      let totalPoints = 0;
      historySnap.forEach(d => { totalPoints += d.data().amount ?? 0; });

      const workoutsSnap: FirebaseFirestoreTypes.QuerySnapshot =
        await getDocs(collection(db, 'users', address, 'workouts'));
      let totalSquats = 0;
      let lastWorkoutDate = 0;
      const dayStarts = new Set<number>();
      const today = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
      let dailyReps = 0;
      workoutsSnap.forEach(d => {
        const reps = d.data().reps ?? 0;
        const ts = d.data().createdAt ?? 0;
        totalSquats += reps;
        if (ts > 0) {
          if (ts > lastWorkoutDate) lastWorkoutDate = ts;
          if (ts >= today) dailyReps += reps;
          const ds = new Date(ts); ds.setHours(0,0,0,0);
          dayStarts.add(ds.getTime());
        }
      });
      const totalWorkouts = dayStarts.size;
      const sortedDays = [...dayStarts].sort((a, b) => a - b);

      let bestStreak = sortedDays.length > 0 ? 1 : 0;
      let run = 1;
      for (let i = 1; i < sortedDays.length; i++) {
        if (sortedDays[i] - sortedDays[i - 1] === 86400000) {
          run++; if (run > bestStreak) bestStreak = run;
        } else {
          run = 1;
        }
      }
      const yesterday = today - 86400000;
      let currentStreak = 0;
      const lastDay = sortedDays[sortedDays.length - 1] ?? 0;
      if (lastDay >= yesterday) {
        currentStreak = 1;
        for (let i = sortedDays.length - 2; i >= 0; i--) {
          if (sortedDays[i + 1] - sortedDays[i] === 86400000) currentStreak++;
          else break;
        }
      }

      // Only update fields where derived > current. Avoids clobbering an
      // in-flight saveWorkout's increment, and avoids redundant writes.
      const updates: Record<string, number> = {};
      if (totalPoints     > (data.points          ?? 0)) updates.points          = totalPoints;
      if (totalSquats     > (data.totalSquats     ?? 0)) updates.totalSquats     = totalSquats;
      if (totalWorkouts   > (data.totalWorkouts   ?? 0)) updates.totalWorkouts   = totalWorkouts;
      if (bestStreak      > (data.bestStreak      ?? 0)) updates.bestStreak      = bestStreak;
      if (currentStreak   > (data.currentStreak   ?? 0)) updates.currentStreak   = currentStreak;
      if (lastWorkoutDate > (data.lastWorkoutDate ?? 0)) updates.lastWorkoutDate = lastWorkoutDate;
      if (dailyReps       > (data.dailyReps       ?? 0)) updates.dailyReps       = dailyReps;
      if (Object.keys(updates).length) {
        updates.updatedAt = now;
        console.log('Data recovery:', JSON.stringify(updates));
        await setDoc(userRef, updates, { merge: true });
      }
    } catch (e) {
      console.log('Recovery error:', e);
    }
  } catch (e: any) {
    console.log('Firestore error:', e?.message, e?.code, JSON.stringify(e));
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const authTokenRef = useRef<string | null>(null);

  // Cold-start restore: read cached session, set publicKey + authTokenRef
  // optimistically. Does NOT call transact() / reauthorize — wallet app
  // stays asleep. Reauthorize fires lazily on the first sign action via
  // authorizeAndSign.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = await loadSession();
      if (cancelled) return;
      if (cached) {
        try {
          setPublicKey(new PublicKey(cached.address));
          authTokenRef.current = cached.authToken;
        } catch (e) {
          console.warn('Cached wallet address invalid:', e);
          await clearSession();
        }
      }
      setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    if (connecting || restoring) return;
    setConnecting(true);
    try {
      await transact(async wallet => {
        const authResult = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: KINLOG_IDENTITY,
        });
        const account = authResult.accounts[0];
        if (account) {
          const addressBytes = Buffer.from(account.address, 'base64');
          const pk = new PublicKey(addressBytes);
          const address = pk.toBase58();
          setPublicKey(pk);
          authTokenRef.current = authResult.auth_token;
          await initUserInFirestore(address);
          await saveSession({ address, authToken: authResult.auth_token });
        }
      });
    } catch (e: any) {
      console.log('Wallet connect error:', e?.message ?? e);
    } finally {
      setConnecting(false);
    }
  }, [connecting, restoring]);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    authTokenRef.current = null;
    void clearSession(); // fire-and-forget
  }, []);

  const authorizeAndSign = useCallback(async (callback: (wallet: any, authToken: string) => Promise<void>) => {
    await transact(async wallet => {
      let authToken = authTokenRef.current;
      let needsFreshAuth = !authToken;
      if (authToken) {
        try {
          await wallet.reauthorize({
            auth_token: authToken,
            identity: KINLOG_IDENTITY,
          });
        } catch (e: any) {
          // Cached token revoked / expired / wallet uninstalled.
          // Fall through to a fresh authorize within the same transact.
          console.log('Reauthorize failed, falling back:', e?.message ?? e);
          needsFreshAuth = true;
          authToken = null;
          authTokenRef.current = null;
        }
      }
      if (needsFreshAuth) {
        const authResult = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: KINLOG_IDENTITY,
        });
        authToken = authResult.auth_token;
        authTokenRef.current = authToken;
        const account = authResult.accounts[0];
        if (account) {
          const addressBytes = Buffer.from(account.address, 'base64');
          const pk = new PublicKey(addressBytes);
          const address = pk.toBase58();
          // First connect OR account switched in wallet — update both
          // state and persisted cache.
          setPublicKey(pk);
          await initUserInFirestore(address);
          await saveSession({ address, authToken });
        }
      }
      await callback(wallet, authToken!);
    });
  }, []);

  const shortAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : null;

  return (
    <WalletContext.Provider value={{ publicKey, shortAddress, connecting, restoring, connect, disconnect, authorizeAndSign }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
