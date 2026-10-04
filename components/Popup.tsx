import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'

const C = { card: '#FFFFFF', dark: '#2D2926', light: '#EDECEA', text: '#1C1917', sub: '#78716C' }

export interface PopupAction {
  label: string
  /** Runs after the popup closes. */
  onPress?: () => void
  /** Dark button; otherwise light grey. */
  primary?: boolean
}

/**
 * Centered popup in the app's own style (the info sheets' look), in place of the native Alert.
 * A tap on the dimmed backdrop or the Android back button closes it, like a button with no action.
 */
export function Popup({
  visible,
  title,
  message,
  actions,
  onClose,
}: {
  visible: boolean
  title: string
  message: string
  actions: PopupAction[]
  onClose: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={s.card}>
          <Text style={s.title}>{title}</Text>
          <Text style={s.message}>{message}</Text>
          <View style={s.actions}>
            {actions.map(a => (
              <TouchableOpacity
                key={a.label}
                style={[s.btn, a.primary ? s.btnDark : s.btnLight]}
                onPress={() => {
                  onClose()
                  a.onPress?.()
                }}
                activeOpacity={0.85}
              >
                <Text style={[s.btnText, a.primary ? s.btnTextWhite : s.btnTextLight]}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', paddingHorizontal: 24 },
  card:    { backgroundColor: C.card, borderRadius: 24, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 20 },
  title:   { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 8 },
  message: { fontSize: 15, color: C.sub, lineHeight: 22 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  // Same size as the info sheets' buttons: fixed height, 17 px text.
  btn:          { flex: 1, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  btnDark:      { backgroundColor: C.dark },
  btnLight:     { backgroundColor: C.light },
  btnText:      { fontSize: 17, fontWeight: '800' },
  btnTextWhite: { color: '#fff' },
  btnTextLight: { color: C.text },
})
