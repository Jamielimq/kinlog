import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { BottomSheet } from './BottomSheet'

const C = {
  dark: '#2D2926', amber2: '#F59E0B', text: '#1C1917', sub: '#78716C', muted: '#A8A29E',
}

// Mirrors the workout screen (app/(tabs)/workout.tsx), in the order a user actually goes: the
// front camera preview is on before Start, Start begins the timer and counting at once, only a
// side view is counted, a rep is down to KNEE_DOWN (110°) then up to KNEE_UP (150°), the session
// stops at 30, and a workout is saved only with a connected wallet.
const STEPS = [
  { title: 'Stand your phone up', detail: 'Lean it against a wall or a shelf.' },
  { title: 'Tap Start', detail: 'Tap it before you step away.' },
  { title: 'Step back', detail: 'Until your whole body shows, head to toe.' },
  { title: 'Turn to the side', detail: 'Kinlog counts squats from your side view.' },
  { title: 'Squat down slowly', detail: "Sit to 110° or less, stand to 150° or more.\nThat's one rep." },
  { title: 'Reach 30 to finish', detail: 'Saved to your history with a connected wallet.' },
]

export function HowToSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <BottomSheet visible={visible} onClose={onClose} title="How to Squat with Kinlog" titleSize={22}>
      <ScrollView style={s.list} showsVerticalScrollIndicator={false}>
        {STEPS.map((step, i) => (
          <View key={step.title} style={s.step}>
            <View style={s.num}>
              <Text style={s.numText}>{i + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.stepTitle}>{step.title}</Text>
              <Text style={s.stepDetail}>{step.detail}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <Text style={s.note}>The camera video is never recorded or saved.</Text>
      <TouchableOpacity style={s.btn} onPress={onClose} activeOpacity={0.85}>
        <Text style={s.btnText}>Got it</Text>
      </TouchableOpacity>
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  // Shrinks and scrolls when the sheet would be taller than the screen allows.
  list:       { flexGrow: 0, flexShrink: 1 },
  step:       { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10 },
  num:        { width: 32, height: 32, borderRadius: 16, backgroundColor: C.amber2, alignItems: 'center', justifyContent: 'center' },
  numText:    { color: '#fff', fontSize: 15, fontWeight: '800' },
  stepTitle:  { fontSize: 16, fontWeight: '700', color: C.text, marginBottom: 2 },
  stepDetail: { fontSize: 14, color: C.sub, lineHeight: 20 },
  note:       { fontSize: 13, color: C.muted, textAlign: 'center', marginTop: 8 },
  // Fixed height (what padding 15 gave with 15 px text) so the larger text doesn't grow the button.
  btn:        { backgroundColor: C.dark, borderRadius: 14, height: 50, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  btnText:    { color: '#fff', fontSize: 17, fontWeight: '800' },
})
