import { getApp } from '@react-native-firebase/app';
import { doc, getDoc, getFirestore, setDoc } from '@react-native-firebase/firestore';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey } from '@solana/web3.js';
import { createContext, useCallback, useContext, useRef, useState } from 'react';

interface WalletContextType {
  publicKey: PublicKey | null;
  shortAddress: string | null;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  authorizeAndSign: (callback: (wallet: any, authToken: string) => Promise<void>) => Promise<void>;
}

const WalletContext = createContext<WalletContextType>({
  publicKey: null,
  shortAddress: null,
  connecting: false,
  connect: async () => {},
  disconnect: () => {},
  authorizeAndSign: async () => {},
});

async function initUserInFirestore(address: string) {
  try {
    const db = getFirestore(getApp());
    const userRef = doc(db, 'users', address);
    const snap = await getDoc(userRef);

    // Only initialize if user doesn't exist yet
    if (!snap.exists()) {
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
    }
  } catch (e: any) {
    console.log('Firestore error:', e?.message, e?.code, JSON.stringify(e));
  }
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const authTokenRef = useRef<string | null>(null);

  const connect = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      await transact(async wallet => {
        const authResult = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: {
            name: 'Kinlog',
            uri: 'https://kinlog.app',
            icon: '/favicon.ico',
          },
        });
        const account = authResult.accounts[0];
        if (account) {
          const addressBytes = Buffer.from(account.address, 'base64');
          const pk = new PublicKey(addressBytes);
          setPublicKey(pk);
          authTokenRef.current = authResult.auth_token;
          await initUserInFirestore(pk.toBase58());
        }
      });
    } catch (e: any) {
      console.log('Wallet connect error:', e?.message ?? e);
    } finally {
      setConnecting(false);
    }
  }, [connecting]);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    authTokenRef.current = null;
  }, []);

  const authorizeAndSign = useCallback(async (callback: (wallet: any, authToken: string) => Promise<void>) => {
    await transact(async wallet => {
      let authToken = authTokenRef.current;
      if (!authToken) {
        const authResult = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: {
            name: 'Kinlog',
            uri: 'https://kinlog.app',
            icon: '/favicon.ico',
          },
        });
        authToken = authResult.auth_token;
        authTokenRef.current = authToken;
        const account = authResult.accounts[0];
        if (account) {
          const addressBytes = Buffer.from(account.address, 'base64');
          const pk = new PublicKey(addressBytes);
          setPublicKey(pk);
          await initUserInFirestore(pk.toBase58());
        }
      } else {
        await wallet.reauthorize({
          auth_token: authToken,
          identity: {
            name: 'Kinlog',
            uri: 'https://kinlog.app',
            icon: '/favicon.ico',
          },
        });
      }
      await callback(wallet, authToken!);
    });
  }, []);

  const shortAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : null;

  return (
    <WalletContext.Provider value={{ publicKey, shortAddress, connecting, connect, disconnect, authorizeAndSign }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  return useContext(WalletContext);
}
