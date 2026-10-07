import { LinearGradient } from 'expo-linear-gradient'
import { StyleSheet, Text, View } from 'react-native'
import { RARITY_COLOR } from '../../constants/rarity'
import type { MonthlyBadge } from '../../lib/record'

// Every medal is the same light orange (Kinlog's orange, brightened); the rim takes the rarity's
// color (constants/rarity.ts), so the rarity shows without changing the medal.
const FILL: [string, string] = ['#FFC870', '#FFA500']
const LOCKED: [string, string] = ['#E7E5E4', '#D6D3D1']

/**
 * A monthly badge drawn as a medal: the number of days it takes ("ALL" for every day of the month),
 * grey while locked, with a check once claimed.
 */
export function MonthlyMedal({ badge, lit, claimed }: { badge: MonthlyBadge; lit: boolean; claimed: boolean }) {
  const label = badge.need === 'all' ? 'ALL' : String(badge.need)
  return (
    <View style={s.wrap}>
      <LinearGradient
        colors={lit ? FILL : LOCKED}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={[s.medal, { borderColor: lit ? RARITY_COLOR[badge.rarity] : LOCKED[1] }]}
      >
        <View style={s.ring}>
          <Text style={[s.num, label.length > 2 && s.numLong, !lit && s.textOff]}>{label}</Text>
          <Text style={[s.unit, !lit && s.textOff]}>{badge.need === 1 ? 'DAY' : 'DAYS'}</Text>
        </View>
      </LinearGradient>
      {claimed && (
        <View style={s.check}>
          <Text style={s.checkText}>✓</Text>
        </View>
      )}
    </View>
  )
}

const SIZE = 56
const RING = SIZE - 14

const s = StyleSheet.create({
  wrap:  { width: SIZE, height: SIZE },
  medal: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  // An inner ring, like the rim of a coin.
  ring:    { width: RING, height: RING, borderRadius: RING / 2, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center' },
  num:     { fontSize: 18, lineHeight: 20, fontWeight: '900', color: '#78350F' },
  numLong: { fontSize: 13, lineHeight: 16 },
  unit:    { fontSize: 7, fontWeight: '800', letterSpacing: 1, color: '#92400E' },
  textOff: { color: '#A8A29E' },
  check:     { position: 'absolute', right: -2, bottom: -2, width: 20, height: 20, borderRadius: 10, backgroundColor: '#2D2926', borderWidth: 2, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  checkText: { fontSize: 10, lineHeight: 12, fontWeight: '900', color: '#FFFFFF' },
})
