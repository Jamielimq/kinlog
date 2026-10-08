// The six Square badges a Locked In pick earns: one per challenge length and tier. The server records
// each settled pick as users/{wallet}/badges/<id>/grants/<cohort> (functions/src/crank/everyMinute.ts
// badgeIdFor), so a badge is earned again with every cohort and claimed once per cohort, the way a
// monthly badge is per month (lib/claims.ts).

export type SquareRarity = 'Common' | 'Rare' | 'Legendary';

export interface SquareBadge {
  id: string; // the server's badge id, e.g. square_3d_common
  days: 3 | 7;
  rarity: SquareRarity;
  name: string;
  desc: string;
  emoji: string;
  pts: number; // below every lifetime badge of the same rarity (Common 100, Rare 500, Legendary 2,000)
}

// Common in grey, as the Square screen shows a Common result (an orange one would read as Legendary).
const EMOJI: Record<SquareRarity, string> = { Common: '⬜', Rare: '🟪', Legendary: '💎' };

const square = (days: 3 | 7, rarity: SquareRarity, pts: number): SquareBadge => ({
  id: `square_${days}d_${rarity.toLowerCase()}`,
  days,
  rarity,
  name: `${days}-Day ${rarity} Square`,
  desc: `A ${rarity} Square from a ${days}-Day Challenge.`,
  emoji: EMOJI[rarity],
  pts,
});

/** Points: plan option A, a share of the completion points (3-Day 300, 7-Day 700): 10%, a third, all. */
export const SQUARE_BADGES: readonly SquareBadge[] = [
  square(3, 'Common', 30),
  square(3, 'Rare', 100),
  square(3, 'Legendary', 300),
  square(7, 'Common', 70),
  square(7, 'Rare', 230),
  square(7, 'Legendary', 700),
];
