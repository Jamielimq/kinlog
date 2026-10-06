import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useWallet } from '../../context/WalletContext'
import { useCohorts } from '../../hooks/useCohorts'
import { useJoinedCohorts } from '../../hooks/useLockedIn'
import { cardSubtitle, shownCohorts } from '../../lib/lockedIn/visibility'

const C = {
  card: '#FFFFFF', dark: '#2D2926', dark3: '#57524E', bg2: '#F5F4F1', bg3: '#EDECEA',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

export function LockedInCard() {
  const { dataAddress } = useWallet()
  const { cohorts } = useCohorts(dataAddress)
  const joined = useJoinedCohorts(dataAddress)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const shown = shownCohorts(cohorts, joined, now / 1000)
  if (!shown.length) return null
  // One group per kind (3-Day first), keeping shownCohorts' order. A kind with nothing shown has no group.
  const groups = [...new Set(shown.map(c => c.kind))].map(kind => shown.filter(c => c.kind === kind))

  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Locked In Challenge</Text>
      {groups.map((group, gi) => (
        <View key={group[0].kind} style={gi < groups.length - 1 && s.group}>
          {/* A label, not a control: no border or shadow, and light where the How to Squat pill is dark. */}
          <View style={s.pill}>
            <Text style={s.pillText}>{`${group[0].days}-DAY`}</Text>
          </View>
          {group.map((c, i) => {
            const mine = joined.find(j => j.key === c.key)
            const isIn = !!mine
            // Only a joined cohort is shown after its end (lib/lockedIn/visibility.ts).
            const ended = isIn && now / 1000 >= c.endTs
            return (
              <TouchableOpacity
                key={c.key}
                style={[s.row, isIn && (ended ? s.rowEnded : s.rowIn), i === group.length - 1 && s.rowLast]}
                onPress={() => router.push(`/locked-in/${c.key}`)}
                activeOpacity={0.85}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[s.title, ended && s.titleEnded]}>{`${c.days}-Day Challenge${c.isTest ? ' (test)' : ''}`}</Text>
                  <Text style={s.sub}>{cardSubtitle(c, mine, now)}</Text>
                </View>
                {/* No deposit amount here: next to a card it reads like a price. The join screen shows it.
                    Seats show until the cohort ends, whether or not this wallet joined, in grey so they
                    don't read like a price either; "joined" keeps them apart from the squat count. */}
                <View style={s.side}>
                  {c.capacity > 0 && now / 1000 < c.endTs && (
                    <Text style={s.seats}>{`${c.participants}/${c.capacity} joined`}</Text>
                  )}
                  <Text style={s.arrow}>→</Text>
                </View>
              </TouchableOpacity>
            )
          })}
        </View>
      ))}
    </View>
  )
}

const s = StyleSheet.create({
  // The section's bottom margin is the whole gap to the next section (the last row has none).
  section:      { marginBottom: 17 },
  // Same as the home screen's sectionTitle, so "Locked In Challenge" and "Quests" match.
  sectionTitle: { fontSize: 20, fontWeight: '900', color: C.text, marginBottom: 12 },
  group:        { marginBottom: 16 },
  pill:         { alignSelf: 'flex-start', backgroundColor: C.bg3, borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 8 },
  pillText:     { fontSize: 10, fontWeight: '800', color: C.dark3, letterSpacing: 1.2 },
  row:          { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 16, padding: 14, borderWidth: 1.5, borderColor: C.line, marginBottom: 10 },
  rowIn:        { backgroundColor: C.amberBg, borderColor: `${C.amber}55` },
  // Ended: a light grey whichever way it ended; the line under the title says what is left.
  rowEnded:     { backgroundColor: C.bg2, borderColor: C.line },
  rowLast:      { marginBottom: 0 },
  title:        { fontSize: 15, fontWeight: '800', color: C.text, marginBottom: 2 },
  titleEnded:   { color: C.dark3 },
  sub:          { fontSize: 12, color: C.sub },
  side:         { alignItems: 'flex-end', justifyContent: 'center', gap: 2 },
  seats:        { fontSize: 11, color: C.muted, fontWeight: '600' },
  arrow:        { fontSize: 18, color: C.muted, fontWeight: '600' },
})
