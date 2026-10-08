// The Badges tab's cards: one per badge, whatever its kind (lifetime, monthly or Square), with how
// often it was earned and the claims still open on it. Pure, so every case can be checked without a
// device.
import type { Badge } from '../hooks/useBadges';
import type { MonthlyBadgeRecord } from '../hooks/useMonthlyBadges';
import type { SquareBadgeRecord } from '../hooks/useSquareBadges';
import { type ClaimItem, lifetimeClaim, monthlyClaim, squareClaim } from './claims';
import { badgeMonths, type DateKey, MONTHLY_BADGES, type MonthlyBadge, monthlyDesc, monthlyReached } from './record';
import { SQUARE_BADGES } from './squareBadges';

/**
 * A claim the wallet sent, while its record doesn't show it claimed: being checked on chain
 * (checking), confirmed but not saved yet (unsaved), or saved a moment ago (saved: the record's
 * listener can lag behind the save, and the next recheck clears it).
 */
export type SentClaimState = 'checking' | 'unsaved' | 'saved';

export type CardCategory = 'monthly' | 'lockedin' | 'squats' | 'streak' | 'special' | 'challenge';
export const CATEGORY_ORDER: readonly CardCategory[] = ['monthly', 'lockedin', 'squats', 'streak', 'special', 'challenge'];

/** Loading until everything is read; Checking while a sent claim of it waits on the chain. */
export type CardState = 'loading' | 'locked' | 'ready' | 'checking' | 'claimed';

export interface BadgeCard {
  key: string;
  category: CardCategory;
  name: string;
  desc: string;
  rarity: string;
  pts: number;
  emoji?: string; // lifetime and Square badges
  medal?: MonthlyBadge; // monthly badges
  earned: number; // times earned: months, cohorts, or once (quests: claimed runs)
  open: ClaimItem[]; // earned, not claimed, not waiting on chain; oldest first, so Claim takes open[0]
  claimIds: string[]; // every record it can be claimed into, to tell whether the claim under way is its own
  state: CardState;
}

export interface CardInputs {
  loading: boolean;
  lifetime: Badge[];
  days: Set<DateKey>;
  today: DateKey;
  monthly: Map<string, MonthlyBadgeRecord> | null;
  grants: Map<string, string[]> | null;
  square: Map<string, SquareBadgeRecord> | null;
  sent: Map<string, SentClaimState> | null;
}

/** One thing a badge can be claimed for: a month, a cohort, or the badge itself. */
interface Unit {
  item: ClaimItem;
  earned: boolean;
  claimed: boolean;
  checking: boolean;
}

type CardBase = Omit<BadgeCard, 'earned' | 'open' | 'claimIds' | 'state'>;

function toCard(base: CardBase, units: Unit[], loading: boolean): BadgeCard {
  const earned = units.filter(u => u.earned);
  const open = earned.filter(u => !u.claimed && !u.checking).map(u => u.item);
  const state: CardState =
    loading ? 'loading'
    : units.some(u => u.checking) ? 'checking'
    : open.length ? 'ready'
    : earned.length ? 'claimed'
    : 'locked';
  return { ...base, earned: earned.length, open, claimIds: units.map(u => u.item.id), state };
}

export function buildCards(x: CardInputs): BadgeCard[] {
  // A recorded claim wins over the copy kept on the phone, which recheck clears soon after.
  const unitOf = (item: ClaimItem, earned: boolean, recorded: boolean): Unit => {
    const sent = x.sent?.get(item.id);
    return { item, earned, claimed: recorded || sent === 'unsaved' || sent === 'saved', checking: !recorded && sent === 'checking' };
  };

  const reached = badgeMonths(x.today).map(m => [m, monthlyReached(x.days, m, x.today)] as const);
  const monthly = MONTHLY_BADGES.map(b =>
    toCard(
      { key: `monthly_${b.type}`, category: 'monthly', name: b.name, desc: monthlyDesc(b), rarity: b.rarity, pts: b.pts, medal: b },
      reached.map(([m, got]) => {
        const item = monthlyClaim(b, m);
        const rec = x.monthly?.get(item.id);
        return unitOf(item, got.has(b.type) || !!rec?.earned || !!rec?.claimed, !!rec?.claimed);
      }),
      x.loading,
    ),
  );

  const square = SQUARE_BADGES.map(b =>
    toCard(
      { key: b.id, category: 'lockedin', name: b.name, desc: b.desc, rarity: b.rarity, pts: b.pts, emoji: b.emoji },
      (x.grants?.get(b.id) ?? []).map(cohort => {
        const item = squareClaim(b, cohort);
        return unitOf(item, true, !!x.square?.get(item.id)?.claimed);
      }),
      x.loading,
    ),
  );

  // The old quest badges show only to wallets that have them; they came claimed with the quest.
  const lifetime = x.lifetime
    .filter(b => b.category !== 'challenge' || b.earned)
    .map(b => {
      const c = toCard(
        { key: b.id, category: b.category, name: b.name, desc: b.desc, rarity: b.rarity, pts: b.pts, emoji: b.emoji },
        [unitOf(lifetimeClaim(b), b.earned, !!b.mintedAt)],
        x.loading,
      );
      return b.category === 'challenge' ? { ...c, earned: Math.max(c.earned, b.instanceCount ?? 0) } : c;
    });

  return [...monthly, ...square, ...lifetime];
}

const RANK: Record<CardState, number> = { ready: 0, checking: 0, claimed: 1, locked: 2, loading: 2 };

/** Ready first, then claimed, then locked; within each, by category in the menu's order. */
export function sortCards(cards: BadgeCard[]): BadgeCard[] {
  return [...cards].sort(
    (a, b) => RANK[a.state] - RANK[b.state] || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
}

/** The tiles: each card in one of Ready (or checking), Earned (claimed) and Locked. */
export function cardCounts(cards: BadgeCard[]) {
  return {
    ready: cards.filter(c => c.state === 'ready' || c.state === 'checking').length,
    earned: cards.filter(c => c.state === 'claimed').length,
    locked: cards.filter(c => c.state === 'locked').length,
    total: cards.length,
  };
}
