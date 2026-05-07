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
    // merge: true ensures existing data is never overwritten
    await setDoc(userRef, { updatedAt: Date.now() }, { merge: true });

    const snap = await getDoc(userRef);
    if (snap.data()?.createdAt == null) {
      // Only set defaults for truly new users
      await setDoc(userRef, {
        points: 0,
        totalWorkouts: 0,
        totalSquats: 0,
        dailyReps: 0,
        bestStreak: 0,
        currentStreak: 0,
        lastWorkoutDate: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      console.log('New user created in Firestore:', address);
    } else {
      console.log('Existing user loaded:', address);

      // Auto-recover from subcollections (source of truth)
      try {
        // Recover points from points_history
        const historyRef = collection(db, 'users', address, 'points_history');
        const historySnap: FirebaseFirestoreTypes.QuerySnapshot = await getDocs(historyRef);
        let totalPoints = 0;
        historySnap.forEach(d => { totalPoints += d.data().amount ?? 0; });

        // Recover workouts and squats from workouts subcollection
        const workoutsRef = collection(db, 'users', address, 'workouts');
        const workoutsSnap: FirebaseFirestoreTypes.QuerySnapshot = await getDocs(workoutsRef);
        let totalSquats = 0;
        const workoutDays = new Set<string>();
        const workoutDates: number[] = [];
        workoutsSnap.forEach(d => {
          totalSquats += d.data().reps ?? 0;
          const ts = d.data().createdAt ?? 0;
          if (ts > 0) {
            const day = new Date(ts).toDateString();
            workoutDays.add(day);
            workoutDates.push(ts);
          }
        });
        const totalWorkouts = workoutDays.size;

        // Calculate best streak from workout dates
        const sortedDays = [...workoutDays].map(d => new Date(d).getTime()).sort((a, b) => a - b);
        let bestStreak = sortedDays.length > 0 ? 1 : 0;
        let currentRun = 1;
        for (let i = 1; i < sortedDays.length; i++) {
          const diff = sortedDays[i] - sortedDays[i - 1];
          if (diff <= 86400000) {
            currentRun++;
            if (currentRun > bestStreak) bestStreak = currentRun;
          } else {
            currentRun = 1;
          }
        }

        const data = snap.data() ?? {};
        const needsRecovery =
          totalPoints > (data.points ?? 0) ||
          totalSquats > (data.totalSquats ?? 0) ||
          totalWorkouts > (data.totalWorkouts ?? 0) ||
          bestStreak > (data.bestStreak ?? 0);

        if (needsRecovery) {
          const updates: any = {};
          if (totalPoints > (data.points ?? 0)) updates.points = totalPoints;
          if (totalSquats > (data.totalSquats ?? 0)) updates.totalSquats = totalSquats;
          if (totalWorkouts > (data.totalWorkouts ?? 0)) updates.totalWorkouts = totalWorkouts;
          if (bestStreak > (data.bestStreak ?? 0)) updates.bestStreak = bestStreak;
          updates.updatedAt = Date.now();
          console.log('Data recovery:', JSON.stringify(updates));
          await setDoc(userRef, updates, { merge: true });
        }
      } catch (e) {
        console.log('Recovery error:', e);
      }
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
