import { getApp } from '@react-native-firebase/app';
import { getAuth, onAuthStateChanged, signInWithCustomToken, signOut } from '@react-native-firebase/auth';
import { collection, doc, FirebaseFirestoreTypes, getDoc, getDocs, getFirestore, setDoc } from '@react-native-firebase/firestore';
import type { SignInPayload, SignInResult } from '@solana-mobile/mobile-wallet-adapter-protocol';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey } from '@solana/web3.js';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchSignInPayload, signInAddress, SignInError, signInErrorMessage, verifySignIn } from '../lib/signIn';

// Firebase session of the connected wallet. Once a wallet has signed in, the rules refuse its data
// to anyone without that wallet's token, so nothing reads or writes users/{wallet} before 'ready'.
export type SessionState = 'checking' | 'needed' | 'signingIn' | 'ready';

interface WalletContextType {
  publicKey: PublicKey | null;
  shortAddress: string | null;
  connecting: boolean;
  // True only during the cold-start cache read. Gate Connect Wallet
  // prompts (and disable taps) before we know whether a cached session
  // exists, to suppress the brief Connect flash + reflexive taps.
  restoring: boolean;
  session: SessionState;
  // The wallet address while its session is ready, otherwise null. Pass this, not publicKey,
  // to anything that reads or writes users/{wallet}.
  dataAddress: string | null;
  // A wallet is connected, connecting has finished, and it still has no session (or is signing
  // in from a Sign in button). Sign-in prompts show only then, so a connect never flashes them.
  awaitingSignIn: boolean;
  signInError: string | null;
  connect: () => Promise<void>;
  signIn: () => Promise<void>;
  disconnect: () => void;
  authorizeAndSign: (callback: (wallet: any, authToken: string) => Promise<void>) => Promise<void>;
}

const WalletContext = createContext<WalletContextType>({
  publicKey: null,
  shortAddress: null,
  connecting: false,
  restoring: true,
  session: 'checking',
  dataAddress: null,
  awaitingSignIn: false,
  signInError: null,
  connect: async () => {},
  signIn: async () => {},
  disconnect: () => {},
  authorizeAndSign: async () => {},
});

const STORAGE_KEY = 'kinlog.wallet.session';
// Kinlog's web address, which also hosts the app's Digital Asset Links (/.well-known/assetlinks.json)
// that wallets check the identity against. The icon path is relative to it: /icon.png.
const KINLOG_IDENTITY = {
  name: 'Kinlog',
  uri: 'https://kinlog.app',
  icon: 'icon.png',
} as const;
const CHAIN = 'solana:mainnet';

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

interface Authorized {
  address: string; // base58
  authToken: string;
  signIn?: SignInResult;
}

/**
 * One wallet session: authorize, plus Sign In With Solana when a payload is given. Wallets that
 * don't sign in natively get the same text signed with sign_messages by the MWA library, still
 * inside this session.
 */
async function authorizeWithSignIn(payload: SignInPayload | null): Promise<Authorized | null> {
  return transact(async wallet => {
    const authResult = await wallet.authorize({
      chain: CHAIN,
      identity: KINLOG_IDENTITY,
      ...(payload ? { sign_in_payload: payload } : {}),
    });
    const account = authResult.accounts[0];
    if (!account) return null;
    return {
      address: new PublicKey(Buffer.from(account.address, 'base64')).toBase58(),
      authToken: authResult.auth_token,
      signIn: authResult.sign_in_result,
    };
  });
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [restoring, setRestoring] = useState(true);
  // undefined until Firebase reports its first auth state (it restores the session natively).
  const [authUid, setAuthUid] = useState<string | null | undefined>(undefined);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const authTokenRef = useRef<string | null>(null);
  // authorizeAndSign is created once; it reads the current address through this ref.
  const addressRef = useRef<string | null>(null);

  const address = publicKey?.toBase58() ?? null;
  useEffect(() => {
    addressRef.current = address;
  }, [address]);
  const session: SessionState =
    restoring || authUid === undefined ? 'checking'
    : signingIn ? 'signingIn'
    : address !== null && authUid === address ? 'ready'
    : 'needed';
  const dataAddress = session === 'ready' ? address : null;
  const awaitingSignIn = address !== null && !connecting && (session === 'needed' || session === 'signingIn');

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

  useEffect(() => onAuthStateChanged(getAuth(getApp()), user => setAuthUid(user?.uid ?? null)), []);

  // One sign-out at a time. disconnect and the cleanup effect below can both ask for it before
  // Firebase's currentUser catches up, and a second call fails with no-current-user.
  const signOutRef = useRef<Promise<void> | null>(null);
  const endSession = useCallback((): Promise<void> => {
    if (!signOutRef.current) {
      const auth = getAuth(getApp());
      signOutRef.current = (auth.currentUser ? signOut(auth) : Promise.resolve())
        .then(() => setAuthUid(null))
        .catch(e => console.log('Sign-out failed:', e?.message ?? e))
        .finally(() => {
          signOutRef.current = null;
        });
    }
    return signOutRef.current;
  }, []);

  // A Firebase session for any other wallet (or for none) must go: the signed-out access an
  // unlinked wallet relies on requires no token at all. connect and signIn handle their own.
  useEffect(() => {
    if (restoring || connecting || signingIn || !authUid || authUid === address) return;
    void endSession();
  }, [restoring, connecting, signingIn, authUid, address, endSession]);

  /** Makes `a` the connected wallet; drops a Firebase session that belongs to another wallet. */
  const adopt = useCallback(async (a: Authorized) => {
    setPublicKey(new PublicKey(a.address));
    authTokenRef.current = a.authToken;
    await saveSession({ address: a.address, authToken: a.authToken });
    const user = getAuth(getApp()).currentUser;
    if (user && user.uid !== a.address) await endSession();
  }, [endSession]);

  /** Trades the wallet's sign-in signature for a Firebase session, then reconciles its data. */
  const completeSignIn = useCallback(async (a: Authorized) => {
    setSigningIn(true);
    try {
      if (!a.signIn) throw new SignInError('no_signature');
      if (signInAddress(a.signIn) !== a.address) throw new SignInError('account_mismatch');
      const token = await verifySignIn(a.signIn);
      const cred = await signInWithCustomToken(getAuth(getApp()), token);
      // Applied now rather than when the auth listener fires, which can land a moment after
      // signingIn clears and would show the session as missing for a frame.
      setAuthUid(cred.user.uid);
      setSignInError(null);
      // Not awaited: the session is usable now, and the screens' listeners pick up the result.
      void initUserInFirestore(a.address);
    } catch (e: any) {
      console.log('Sign-in failed:', e?.message ?? e);
      setSignInError(signInErrorMessage(e));
    } finally {
      setSigningIn(false);
    }
  }, []);

  const connect = useCallback(async () => {
    if (connecting || restoring) return;
    setConnecting(true);
    setSignInError(null);
    try {
      // Fetched first so that connecting and signing in take one wallet session. Without it the
      // wallet still connects, and the session waits for signIn().
      const payload = await fetchSignInPayload();
      const a = await authorizeWithSignIn(payload);
      if (!a) return;
      await adopt(a);
      if (payload) await completeSignIn(a);
      else setSignInError(signInErrorMessage(new SignInError('unavailable')));
    } catch (e: any) {
      console.log('Wallet connect error:', e?.message ?? e);
    } finally {
      setConnecting(false);
    }
  }, [connecting, restoring, adopt, completeSignIn]);

  /** Signs in the connected wallet (or whichever account the user picks in the wallet). */
  const signIn = useCallback(async () => {
    if (connecting || signingIn || restoring) return;
    setSignInError(null);
    setSigningIn(true);
    try {
      const payload = await fetchSignInPayload();
      if (!payload) throw new SignInError('unavailable');
      const a = await authorizeWithSignIn(payload);
      if (!a) return;
      await adopt(a);
      await completeSignIn(a);
    } catch (e: any) {
      console.log('Sign-in error:', e?.message ?? e);
      if (e instanceof SignInError) setSignInError(signInErrorMessage(e));
    } finally {
      setSigningIn(false);
    }
  }, [connecting, signingIn, restoring, adopt, completeSignIn]);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    authTokenRef.current = null;
    setSignInError(null);
    void clearSession(); // fire-and-forget
    void endSession();
  }, [endSession]);

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
          chain: CHAIN,
          identity: KINLOG_IDENTITY,
        });
        authToken = authResult.auth_token;
        authTokenRef.current = authToken;
        const account = authResult.accounts[0];
        if (account) {
          const pk = new PublicKey(Buffer.from(account.address, 'base64'));
          const next = pk.toBase58();
          await saveSession({ address: next, authToken });
          if (next !== addressRef.current) {
            // Account switched in the wallet: that wallet needs its own sign-in before anything
            // is signed or written for it.
            setPublicKey(pk);
            throw new Error('Wallet account changed. Please sign in again.');
          }
        }
      }
      await callback(wallet, authToken!);
    });
  }, []);

  const shortAddress = address ? `${address.slice(0, 4)}...${address.slice(-4)}` : null;

  return (
    <WalletContext.Provider
      value={{
        publicKey, shortAddress, connecting, restoring, session, dataAddress, awaitingSignIn, signInError,
        connect, signIn, disconnect, authorizeAndSign,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
