import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useWallet } from '../../context/WalletContext'
import { type CohortView, useCohorts } from '../../hooks/useCohorts'
import { useJoinedCohorts } from '../../hooks/useLockedIn'
import { joiningClosesTs } from '../../lib/lockedIn/program'
import { cohortDayIndex, formatUtc } from '../../lib/lockedIn/time'
import { dueLines, isFull, type JoinedCohort, shownCohorts } from '../../lib/lockedIn/visibility'

const C = {
  card: '#FFFFFF', dark: '#2D2926',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

function subtitle(c: CohortView, j: JoinedCohort | undefined, nowMs: number): string {
  const nowSec = nowMs / 1000
  const day = cohortDayIndex(c.startTs, c.daySeconds, nowMs) + 1
  if (j) {
    if (nowSec < c.startTs) return `You're in. Starts ${formatUtc(c.startTs)}`
    if (nowSec < c.endTs) return `You're in. Day ${day} of ${c.days}`
    // An ended cohort is shown only while something is due (lib/lockedIn/visibility.ts).
    return dueLines(c, j).join('\n') || `Ended ${formatUtc(c.endTs)}`
  }
  // A full cohort says so while joining is open; once joining closes, that is what matters.
  const full = isFull(c)
  if (nowSec < c.startTs) return full ? `Starts ${formatUtc(c.startTs)}. Full` : `Starts ${formatUtc(c.startTs)}`
  if (nowSec < joiningClosesTs(c)) {
    return full ? `Day 1 of ${c.days}. Full` : `Day 1 of ${c.days}. Join until ${formatUtc(joiningClosesTs(c))}`
  }
  return `Day ${day} of ${c.days}. Joining closed`
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

  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>Locked In Challenge</Text>
      {shown.map((c, i) => {
        const mine = joined.find(j => j.key === c.key)
        const isIn = !!mine
        return (
          <TouchableOpacity
            key={c.key}
            style={[s.row, isIn && s.rowIn, i === shown.length - 1 && s.rowLast]}
            onPress={() => router.push(`/locked-in/${c.key}`)}
            activeOpacity={0.85}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.title}>{`${c.days}-Day Challenge${c.isTest ? ' (test)' : ''}`}</Text>
              <Text style={s.sub}>{subtitle(c, mine, now)}</Text>
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
  )
}

const s = StyleSheet.create({
  // The section's bottom margin is the whole gap to the next section (the last row has none).
  section:      { marginBottom: 17 },
  // Same as the home screen's sectionTitle, so "Locked In Challenge" and "Quests" match.
  sectionTitle: { fontSize: 20, fontWeight: '900', color: C.text, marginBottom: 12 },
  row:          { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.card, borderRadius: 16, padding: 14, borderWidth: 1.5, borderColor: C.line, marginBottom: 10 },
  rowIn:        { backgroundColor: C.amberBg, borderColor: `${C.amber}55` },
  rowLast:      { marginBottom: 0 },
  title:        { fontSize: 15, fontWeight: '800', color: C.text, marginBottom: 2 },
  sub:          { fontSize: 12, color: C.sub },
  side:         { alignItems: 'flex-end', justifyContent: 'center', gap: 2 },
  seats:        { fontSize: 11, color: C.muted, fontWeight: '600' },
  arrow:        { fontSize: 18, color: C.muted, fontWeight: '600' },
})
