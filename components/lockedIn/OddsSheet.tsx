import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { BottomSheet } from '../BottomSheet'

const C = {
  dark: '#2D2926', amber: '#D97706', text: '#1C1917', sub: '#78716C', line: '#E7E5E4',
}

// The only place in the app that shows odds (docs/LOCKED_IN.md, sections 2 and 8). Each "1 in N"
// sits on its own line under the sentence.
const ROWS = [
  { tier: 'Legendary Square', odds: '0.2%', detail: 'The ORE round your pick targets hits the motherlode.\n(1 in 500)' },
  { tier: 'Rare Square', odds: '4.0%', detail: "Your Square is that round's winning square.\n(1 in 25)" },
  { tier: 'Common Square', odds: '95.8%', detail: 'Every other pick.' },
]

export function OddsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title="Reward odds">
      <ScrollView style={s.body} showsVerticalScrollIndicator={false}>
        {ROWS.map(row => (
          <View key={row.tier} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.tier}>{row.tier}</Text>
              <Text style={s.detail}>{row.detail}</Text>
            </View>
            <Text style={s.odds}>{row.odds}</Text>
          </View>
        ))}
        <Text style={s.note}>
          Every pick wins at least a Common Square. Each challenge has at most 1 Legendary and 3 Rare Squares.
        </Text>
        <Text style={s.note}>
          Results come from <Text style={s.strong}>ORE mining rounds</Text>. Kinlog uses ORE&apos;s round rules
          as of October 2026. If ORE changes them, these odds stay as listed until Kinlog updates its program.
        </Text>
      </ScrollView>
      <TouchableOpacity style={s.btn} onPress={onClose} activeOpacity={0.85}>
        <Text style={s.btnText}>OK</Text>
      </TouchableOpacity>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  body:    { flexGrow: 0, flexShrink: 1, marginTop: 4 },
  row:     { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  tier:    { fontSize: 14, fontWeight: '700', color: C.text, marginBottom: 2 },
  detail:  { fontSize: 12, color: C.sub, lineHeight: 17 },
  odds:    { fontSize: 15, fontWeight: '800', color: C.amber },
  note:    { fontSize: 12, color: C.sub, lineHeight: 18, marginTop: 12 },
  // Same emphasis as the join screen's key lines.
  strong:  { color: C.amber, fontWeight: '600' },
  // Same button as the how-to sheet: fixed height, 17 px text.
  btn:     { backgroundColor: C.dark, borderRadius: 14, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 20 },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '800' },
})
