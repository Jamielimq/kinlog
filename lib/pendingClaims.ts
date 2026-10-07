// Monthly badge claims whose payment the wallet has sent but the app hasn't recorded yet, kept on the
// phone per wallet (expo-secure-store), so a payment that went through is recorded later instead of
// paid again. Each is removed once recorded, or once the chain shows it failed or can no longer land.
import * as SecureStore from 'expo-secure-store';
import type { MonthKey, MonthlyType } from './record';

export interface PendingClaim {
  id: string; // the badge record's id, month_<type>_<YYYYMM>
  type: MonthlyType;
  month: MonthKey;
  memo: string;
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

async function read(wallet: string): Promise<PendingClaim[]> {
  try {
    const raw = await SecureStore.getItemAsync(keyOf(wallet));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as PendingClaim[]) : [];
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
