// What claiming a badge records, whichever kind it is: the record it marks claimed, the memo it carries
// on chain (lib/badgeClaim.ts), and the points it adds once. Built here so the claim flow
// (context/ClaimsContext.tsx) and the claims kept on the phone (lib/pendingClaims.ts) treat every
// badge the same way.
import { claimMemo, type MonthKey, monthLabel, monthlyBadgeId, type MonthlyBadge, monthlyPointsId } from './record';
import type { SquareBadge } from './squareBadges';

export type ClaimKind = 'monthly' | 'square' | 'lifetime';

export interface ClaimItem {
  kind: ClaimKind;
  id: string; // users/{wallet}/badges/<id>: the record a claim marks
  memo: string;
  pts: number;
  pointsId: string; // users/{wallet}/points_history/<pointsId>: fixed, so a retry can't add the points twice
  reason: string; // the points_history line ("Claimed badge: ...", as lifetime claims always wrote)
  name: string;
  fields: Record<string, string>; // what a monthly or Square record says about its badge
}

export const monthlyClaim = (b: MonthlyBadge, month: MonthKey): ClaimItem => ({
  kind: 'monthly',
  id: monthlyBadgeId(b.type, month),
  memo: claimMemo(b.type, month),
  pts: b.pts,
  pointsId: monthlyPointsId(b.type, month),
  reason: `Claimed badge: ${b.name} (${monthLabel(month)})`,
  name: b.name,
  fields: { type: b.type, month },
});

/** One Square badge from one cohort (its grant's id, e.g. 0-20261004). */
export const squareClaim = (b: SquareBadge, cohort: string): ClaimItem => ({
  kind: 'square',
  id: `${b.id}_${cohort}`,
  memo: `kinlog:badge:square:${b.id}:${cohort}`,
  pts: b.pts,
  pointsId: `sb-${b.id}-${cohort}`,
  reason: `Claimed badge: ${b.name}`,
  name: b.name,
  fields: { badge: b.id, cohort },
});

/** A lifetime badge (hooks/useBadges.ts), claimed once; its record keeps the mintedAt it always had. */
export const lifetimeClaim = (b: { id: string; name: string; pts: number }): ClaimItem => ({
  kind: 'lifetime',
  id: b.id,
  memo: `kinlog:badge:lifetime:${b.id}`,
  pts: b.pts,
  pointsId: `lb-${b.id}`,
  reason: `Claimed badge: ${b.name}`,
  name: b.name,
  fields: {},
});
