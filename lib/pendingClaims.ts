// Badge claims whose payment the wallet has sent but the app hasn't recorded yet, kept on the phone per
// wallet (expo-secure-store), so a payment that went through is recorded later instead of paid again.
// Each is removed once recorded, or once the chain shows it failed or can no longer land.
import * as SecureStore from 'expo-secure-store';
import { type ClaimItem, monthlyClaim } from './claims';
import { MONTHLY_BADGES } from './record';

export interface PendingClaim extends ClaimItem {
  signature: string;
  lastValidBlockHeight: number; // past this block height, a transaction that hasn't landed never will
  sentAt: number;
}

const keyOf = (wallet: string) => `kinlog.pendingBadgeClaims.${wallet}`;

// One change at a time, so a save and a removal can't overwrite each other.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** An entry as saved before claims covered every badge kind (monthly only: type and month, no kind). */
function upgrade(x: any): PendingClaim | null {
  if (x?.kind) return x as PendingClaim;
  const badge = MONTHLY_BADGES.find(b => b.type === x?.type);
  if (!badge || typeof x?.month !== 'string' || typeof x?.signature !== 'string') return null;
  return { ...monthlyClaim(badge, x.month), signature: x.signature, lastValidBlockHeight: x.lastValidBlockHeight ?? 0, sentAt: x.sentAt ?? 0 };
}

async function read(wallet: string): Promise<PendingClaim[]> {
  try {
    const raw = await SecureStore.getItemAsync(keyOf(wallet));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map(upgrade).filter((p): p is PendingClaim => p !== null) : [];
  } catch (e: any) {
    console.log('pending claims read failed:', e?.message ?? e);
    return [];
  }
}

async function write(wallet: string, list: PendingClaim[]) {
  if (list.length) await SecureStore.setItemAsync(keyOf(wallet), JSON.stringify(list));
  else await SecureStore.deleteItemAsync(keyOf(wallet));
}

export const loadPending = (wallet: string) => serial(() => read(wallet));

export const addPending = (wallet: string, p: PendingClaim) =>
  serial(async () => write(wallet, [...(await read(wallet)).filter(x => x.signature !== p.signature), p]));

export const removePending = (wallet: string, signature: string) =>
  serial(async () => write(wallet, (await read(wallet)).filter(x => x.signature !== signature)));
