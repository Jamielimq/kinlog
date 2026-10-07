import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { DAILY_GOAL, type DateKey, type MonthKey, monthCells, monthLabel } from '../../lib/record'

const C = {
  card: '#FFFFFF', bg2: '#F5F4F1',
  // amberTint: the app's amberBg (#FFFBEB) disappears on a white card.
  amber: '#D97706', amber2: '#F59E0B', amberTint: '#FEF3C7',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', faint: '#D6D3D1', line: '#E7E5E4',
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/**
 * One month, Monday first and always six rows, so what sits below never moves. A day that reached
 * the daily goal is filled, a day with squats short of it is tinted, and today is ringed. An arrow
 * without a handler is the end of the range.
 */
export function MonthCalendar({ month, totals, today, onPrev, onNext }: {
  month: MonthKey
  totals: Map<DateKey, number>
  today: DateKey
  onPrev?: () => void
  onNext?: () => void
}) {
  const cells = monthCells(month)
  const weeks = Array.from({ length: 6 }, (_, w) => cells.slice(w * 7, w * 7 + 7))

  return (
    <View style={s.card}>
      <View style={s.head}>
        <Arrow label="‹" onPress={onPrev} />
        <Text style={s.title}>{monthLabel(month)}</Text>
        <Arrow label="›" onPress={onNext} />
      </View>
      <View style={s.week}>
        {WEEKDAYS.map((d, i) => (
          <Text key={i} style={s.weekday}>{d}</Text>
        ))}
      </View>
      {weeks.map((week, w) => (
        <View key={w} style={s.week}>
          {week.map((k, i) => {
            if (!k) return <View key={i} style={s.cell} />
            const reps = totals.get(k) ?? 0
            const met = reps >= DAILY_GOAL
            const some = !met && reps > 0
            return (
              <View key={i} style={s.cell}>
                <View style={[s.day, met && s.dayMet, some && s.daySome, k === today && s.dayToday]}>
                  <Text style={[s.dayText, met && s.dayTextMet, some && s.dayTextSome, k > today && s.dayTextLater]}>
                    {Number(k.slice(8))}
                  </Text>
                </View>
              </View>
            )
          })}
        </View>
      ))}
      {/* The gap sits between the items: a swatch given its own margin drew square on Android. */}
      <View style={s.legend}>
        <View style={s.legendItem}>
          <View style={[s.swatch, s.dayMet]} />
          <Text style={s.legendText}>{`${DAILY_GOAL} squats`}</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.swatch, s.daySome]} />
          <Text style={s.legendText}>{`Under ${DAILY_GOAL}`}</Text>
        </View>
      </View>
    </View>
  )
}

function Arrow({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <TouchableOpacity
      style={[s.arrow, !onPress && s.arrowOff]}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.7}
      hitSlop={8}
    >
      <Text style={[s.arrowText, !onPress && s.arrowTextOff]}>{label}</Text>
    </TouchableOpacity>
  )
}

const s = StyleSheet.create({
  card:  { backgroundColor: C.card, borderRadius: 22, padding: 16, marginBottom: 14, borderWidth: 1.5, borderColor: C.line },
  head:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { fontSize: 17, fontWeight: '800', color: C.text },

  // The screens' back button, smaller.
  arrow:        { width: 34, height: 34, borderRadius: 11, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  arrowOff:     { borderColor: C.bg2 },
  arrowText:    { fontSize: 20, lineHeight: 22, fontWeight: '700', color: C.text },
  arrowTextOff: { color: C.faint },

  week:    { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '700', color: C.muted, marginBottom: 4 },
  cell:    { flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  // Every day has a border (clear unless today), so today's circle is the same size as the others.
  day:          { width: '84%', aspectRatio: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  dayMet:       { backgroundColor: C.amber2 },
  daySome:      { backgroundColor: C.amberTint },
  dayToday:     { borderColor: C.amber },
  dayText:      { fontSize: 13, fontWeight: '600', color: C.sub },
  dayTextMet:   { color: '#fff', fontWeight: '800' },
  dayTextSome:  { color: C.amber, fontWeight: '700' },
  dayTextLater: { color: C.faint },

  legend:     { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch:     { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, color: C.sub },
})
