import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { RARITY_COLOR } from '../../constants/rarity'
import { FIRST_BADGE_MONTH, type MonthKey, monthLabel, type MonthlyBadge } from '../../lib/record'
import { MonthlyMedal } from './MonthlyMedal'

const C = {
  card: '#FFFFFF', bg2: '#F5F4F1', dark: '#2D2926',
  amber2: '#F59E0B',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

/**
 * Locked until the month's workouts earn it, then Unlocked (claimable) until claimed. Checking: a
 * claim the wallet sent isn't confirmed yet. Loading: the workouts or the records aren't read yet.
 */
export type MonthlyBadgeState = 'loading' | 'locked' | 'unlocked' | 'checking' | 'claimed'

export interface MonthlyBadgeItem {
  badge: MonthlyBadge
  state: MonthlyBadgeState
  busy: boolean // its claim is under way
}

/**
 * The shown month's nine monthly badges, 3 × 3, with the current streak beside the title when the
 * screen passes one. Only an unlocked badge responds to a tap, which claims it straight away; no
 * other can be pressed, nor any while a claim is under way.
 */
export function MonthlyBadgeGrid({ month, items, streak, onClaim }: {
  month: MonthKey
  items: MonthlyBadgeItem[]
  streak?: number
  onClaim: (item: MonthlyBadgeItem) => void
}) {
  const started = month >= FIRST_BADGE_MONTH
  const loading = items.some(i => i.state === 'loading')
  const rows = [0, 1, 2].map(r => items.slice(r * 3, r * 3 + 3))
  const earned = items.filter(i => i.state !== 'locked' && i.state !== 'loading').length
  const claiming = items.some(i => i.busy)

  return (
    <View style={s.card}>
      <View style={s.head}>
        <Text style={s.title}>Monthly Badges</Text>
        {streak !== undefined && <Text style={s.streak}>{`${streak}-day streak`}</Text>}
        {started && !loading && <Text style={s.count}>{`${earned}/${items.length}`}</Text>}
      </View>
      {rows.map((row, r) => (
        <View key={r} style={s.row}>
          {row.map(item => {
            const { badge, state, busy } = item
            const lit = state !== 'locked' && state !== 'loading'
            const pressable = state === 'unlocked' && !claiming
            return (
              <TouchableOpacity
                key={badge.type}
                style={s.tile}
                onPress={pressable ? () => onClaim(item) : undefined}
                disabled={!pressable}
                activeOpacity={0.8}
              >
                {/* The points it gives when claimed: fixed, so shown even while loading. */}
                <Text style={[s.pts, !lit && s.ptsOff]}>{`+${badge.pts}`}</Text>
                <MonthlyMedal badge={badge} lit={lit} claimed={state === 'claimed'} />
                <Text style={[s.name, !lit && s.nameOff]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                  {badge.name}
                </Text>
                {/* One status line per tile, the same height in every state, so a row's tiles line up. */}
                {state === 'loading' && <Text style={s.status}> </Text>}
                {state === 'locked' && <Text style={s.status}>Locked</Text>}
                {state === 'checking' && !busy && <Text style={s.status}>Checking...</Text>}
                {(state === 'unlocked' || (state === 'checking' && busy)) && (
                  <View style={[s.claimBtn, busy && s.claimBtnBusy]}>
                    <Text style={s.claimText}>{busy ? 'Claiming...' : 'Claim'}</Text>
                  </View>
                )}
                {state === 'claimed' && <Text style={[s.claimed, { color: RARITY_COLOR[badge.rarity] }]}>Claimed</Text>}
              </TouchableOpacity>
            )
          })}
        </View>
      ))}
      {!started && <Text style={s.foot}>{`Monthly badges start in ${monthLabel(FIRST_BADGE_MONTH)}`}</Text>}
    </View>
  )
}

const s = StyleSheet.create({
  card:  { backgroundColor: C.card, borderRadius: 22, padding: 16, marginBottom: 14, borderWidth: 1.5, borderColor: C.line },
  head:   { flexDirection: 'row', alignItems: 'baseline', marginBottom: 12 },
  title:  { fontSize: 17, fontWeight: '800', color: C.text },
  // In the text color, smaller than the title, on its baseline.
  streak: { fontSize: 13, fontWeight: '600', color: C.text, marginLeft: 8 },
  count:  { fontSize: 13, fontWeight: '700', color: C.sub, marginLeft: 'auto' },

  row:  { flexDirection: 'row', gap: 8, marginBottom: 8 },
  tile: { flex: 1, alignItems: 'center', paddingTop: 12, paddingBottom: 10, paddingHorizontal: 6, borderRadius: 16, backgroundColor: C.bg2 },
  // In the tile's top right corner, clear of the medal ("+300" included), so nothing else moves.
  pts:    { position: 'absolute', top: 6, right: 8, fontSize: 11, fontWeight: '700', color: C.sub },
  ptsOff: { color: C.muted },
  name:    { fontSize: 12, fontWeight: '800', color: C.text, marginTop: 8 },
  nameOff: { color: C.muted },
  // One line each, the same height, so a row's tiles line up whatever their state.
  status:       { fontSize: 11, fontWeight: '600', color: C.muted, marginTop: 6, lineHeight: 20 },
  claimBtn:     { marginTop: 6, height: 20, paddingHorizontal: 12, borderRadius: 100, backgroundColor: C.dark, justifyContent: 'center' },
  claimBtnBusy: { backgroundColor: C.muted },
  claimText:    { fontSize: 11, fontWeight: '800', color: C.amber2 },
  claimed:      { fontSize: 11, fontWeight: '800', marginTop: 6, lineHeight: 20 },

  foot: { fontSize: 12, color: C.sub, marginTop: 4 },
})
