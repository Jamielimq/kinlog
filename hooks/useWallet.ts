import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey } from '@solana/web3.js';
import { useCallback, useState } from 'react';

export function useWallet() {
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      await transact(async wallet => {
        const authResult = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: {
            name: '2048 on Seeker',
            uri: 'https://seeker2048.app',
            icon: '/favicon.ico',
          },
        });
        console.log('Auth result:', JSON.stringify(authResult));
        const account = authResult.accounts[0];
        if (account) {
          // address는 base64 인코딩된 바이트 배열
          const addressBytes = Buffer.from(account.address, 'base64');
          const pk = new PublicKey(addressBytes);
          console.log('Connected:', pk.toBase58());
          setPublicKey(pk);
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
  }, []);

  const shortAddress = publicKey
    ? `${publicKey.toBase58().slice(0, 4)}...${publicKey.toBase58().slice(-4)}`
    : null;

  return { publicKey, shortAddress, connecting, connect, disconnect };
}