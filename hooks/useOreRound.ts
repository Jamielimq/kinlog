import { useEffect, useState } from 'react';
import { readResultAt, readSlotMs } from '../lib/lockedIn/ore';
import { getConnection } from '../lib/solana';

const POLL_MS = 15_000;

/**
 * While a pick waits for its ORE round: when the round's result should exist (ms since the epoch,
 * 0 once ORE has moved past the round), estimated again every 15 s from ORE's board. null until the
 * first read, when the board gives no usable figure, or when roundId is null (nothing to wait for).
 */
export function useOreRound(roundId: bigint | null) {
  const [resultAt, setResultAt] = useState<number | null>(null);
  const key = roundId === null ? null : roundId.toString();

  useEffect(() => {
    setResultAt(null);
    if (key === null) return;
    const round = BigInt(key);
    let cancelled = false;
    let slotMs: number | null = null;
    const read = async () => {
      try {
        const connection = getConnection();
        slotMs ??= await readSlotMs(connection);
        const at = await readResultAt(connection, round, slotMs);
        if (!cancelled) setResultAt(at);
      } catch (e: any) {
        // The last estimate stays.
        console.log('ORE round read failed:', e?.message ?? e);
      }
    };
    void read();
    const timer = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);

  return { resultAt };
}
