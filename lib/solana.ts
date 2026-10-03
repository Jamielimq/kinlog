// Mainnet RPC for the app's own reads, simulations and confirmations. A Helius key (optional)
// raises rate limits; without one the public endpoint is used. Transactions are sent by the wallet.
import { Connection } from '@solana/web3.js';

const HELIUS_API_KEY = process.env.EXPO_PUBLIC_HELIUS_API_KEY;
export const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

let shared: Connection | null = null;

export function getConnection(): Connection {
  if (!shared) shared = new Connection(RPC_URL, 'confirmed');
  return shared;
}
