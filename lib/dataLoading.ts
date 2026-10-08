// When a screen's numbers wait, blank, for the connected wallet's data: Home, Profile, Goals and
// Badges all follow this one rule.

/**
 * True while a connected wallet's data can't be read yet (no session: the sign-in prompt, or still
 * checking) or is being read. Someone updating from 1.3.3 sees the sign-in prompt first, and 0 points
 * or "EARNED 0" there would read as lost progress. With no wallet connected nothing waits: the
 * screens show their zeros and Locked badges as before.
 */
export function dataLoading(walletConnected: boolean, dataAddress: string | null, reading: boolean): boolean {
  return walletConnected && (!dataAddress || reading);
}
