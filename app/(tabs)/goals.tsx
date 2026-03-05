import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWallet } from '../../context/WalletContext'
import { useGoals } from '../../hooks/useGoals'
import { useWeeklyChart } from '../../hooks/useWeeklyChart'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

export default function GoalsScreen() {
  const { publicKey } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { goals, loading } = useGoals(address)
  const { days } = useWeeklyChart(address)

  const maxReps = Math.max(...days.map(d => d.reps), 1)

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <Text style={s.headerSub}>Tracking</Text>
          <Text style={s.headerTitle}>Goal Tracker</Text>
        </View>

        {!publicKey && (
          <View style={s.noWallet}>
            <Text style={s.noWalletText}>Connect your wallet to track goals</Text>
          </View>
        )}

        {/* Goal cards */}
        {goals.map((g) => {
          const pct = Math.min(Math.round((g.current / g.total) * 100), 100)
          return (
            <View key={g.id} style={s.goalCard}>
              <View style={s.goalTop}>
                <View style={{ flex: 1 }}>
                  <View style={s.tagWrap}>
                    <Text style={s.tagText}>{g.tag}</Text>
                  </View>
                  <Text style={s.goalTitle}>{g.title}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={[s.goalPct, { color: g.color }]}>{pct}%</Text>
                  <Text style={s.goalFrac}>{g.current} / {g.total}</Text>
                </View>
              </View>

              {/* Progress bar */}
              <View style={s.progressTrack}>
                <View style={[s.progressFill, { width: `${pct}%`, backgroundColor: g.color }]}/>
              </View>
              <Text style={s.goalNote}>{g.note}</Text>

              {/* Weekly bar chart - 실제 Firebase 데이터 */}
              {g.tag === 'Weekly' && (
                <View style={s.barChart}>
                  {days.map((day, j) => {
                    const heightPct = maxReps > 0 ? day.reps / maxReps : 0
                    return (
                      <View key={j} style={s.barCol}>
                        <Text style={[s.barReps, day.isToday && { color: C.amber2 }]}>
                          {day.reps > 0 ? day.reps : ''}
                        </Text>
                        <View style={s.barTrack}>
                          <View style={[
                            s.barFill,
                            {
                              height: `${Math.max(heightPct * 100, day.reps > 0 ? 8 : 0)}%`,
                              backgroundColor: day.isToday
                                ? C.amber2
                                : day.reps > 0
                                  ? 'rgba(14,165,233,0.5)'
                                  : C.bg3,
                            },
                          ]}/>
                        </View>
                        <Text style={[s.barLabel, day.isToday && { color: C.amber2, fontWeight: '700' }]}>
                          {day.label}
                        </Text>
                      </View>
                    )
                  })}
                </View>
              )}

              {/* Monthly dots */}
              {g.tag === 'Monthly' && (
                <View style={s.dotGrid}>
                  {Array.from({ length: g.total }, (_, k) => k + 1).map(d => (
                    <View key={d} style={[s.dot, d <= g.current && s.dotActive]}>
                      <Text style={[s.dotText, d <= g.current && s.dotTextActive]}>{d}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )
        })}

        {/* New Goal button */}
        <TouchableOpacity style={s.newGoalBtn} activeOpacity={0.85}>
          <Text style={s.newGoalText}>+ Set New Goal</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1, paddingHorizontal: 20 },

  header:      { paddingTop: 16, paddingBottom: 16 },
  headerSub:   { fontSize: 10, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: C.text },

  noWallet:     { backgroundColor: C.amberBg, borderRadius: 14, padding: 16, marginBottom: 16, alignItems: 'center' },
  noWalletText: { fontSize: 13, color: C.amber, fontWeight: '600' },

  goalCard:  { backgroundColor: C.card, borderRadius: 22, padding: 18, marginBottom: 14, borderWidth: 1.5, borderColor: C.line, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2 },
  goalTop:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 },

  tagWrap: { backgroundColor: C.bg2, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 100, alignSelf: 'flex-start', marginBottom: 8 },
  tagText: { fontSize: 10, fontWeight: '700', color: C.sub, letterSpacing: 0.5 },

  goalTitle: { fontSize: 16, fontWeight: '800', color: C.text },
  goalPct:   { fontSize: 30, fontWeight: '900', lineHeight: 32 },
  goalFrac:  { fontSize: 10, color: C.muted, marginTop: 2 },

  progressTrack: { height: 7, backgroundColor: C.bg2, borderRadius: 100, overflow: 'hidden', marginBottom: 10 },
  progressFill:  { height: 7, borderRadius: 100 },
  goalNote:      { fontSize: 11, color: C.muted },

  barChart: { flexDirection: 'row', gap: 6, alignItems: 'flex-end', marginTop: 16, height: 80 },
  barCol:   { flex: 1, alignItems: 'center', gap: 4 },
  barReps:  { fontSize: 8, color: C.muted, height: 12 },
  barTrack: { width: '100%', flex: 1, backgroundColor: C.bg2, borderRadius: 6, overflow: 'hidden', justifyContent: 'flex-end' },
  barFill:  { width: '100%', borderRadius: 6 },
  barLabel: { fontSize: 8, color: C.muted },

  dotGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 14 },
  dot:           { width: 28, height: 28, borderRadius: 14, backgroundColor: C.bg2, alignItems: 'center', justifyContent: 'center' },
  dotActive:     { backgroundColor: C.amber2 },
  dotText:       { fontSize: 8, color: C.muted },
  dotTextActive: { color: '#fff', fontWeight: '700' },

  newGoalBtn:  { backgroundColor: C.dark, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginBottom: 24, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.12, shadowRadius: 12, elevation: 4 },
  newGoalText: { fontSize: 15, fontWeight: '700', color: C.amber2 },
})
