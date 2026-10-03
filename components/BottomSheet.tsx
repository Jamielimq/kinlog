import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, Dimensions, Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native'

const C = { card: '#FFFFFF', text: '#1C1917', line: '#E7E5E4' }

// How far, or how fast, the handle must be pulled down before the sheet closes.
const CLOSE_DISTANCE = 100
const CLOSE_VELOCITY = 0.8

/**
 * Bottom sheet for the app's info sheets. It closes from its own button (passed in children), the
 * Android back button, a tap on the dimmed backdrop, or a downward drag on the handle or title.
 * Only the handle and title take drags, so scrolling inside the sheet is never captured.
 * Built on PanResponder and Animated only, so it needs no native module.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  titleSize = 18,
  children,
}: {
  visible: boolean
  onClose: () => void
  title: string
  titleSize?: number
  children: ReactNode
}) {
  const [translateY] = useState(() => new Animated.Value(0))
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // A drag-close leaves the sheet below the screen; put it back before it is shown again
  // (the modal fades in from transparent, so the reset is never seen).
  useEffect(() => {
    if (visible) translateY.setValue(0)
  }, [visible, translateY])

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 2,
        onPanResponderMove: (_, g) => translateY.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_, g) => {
          if (g.dy > CLOSE_DISTANCE || g.vy > CLOSE_VELOCITY) {
            Animated.timing(translateY, {
              toValue: Dimensions.get('window').height,
              duration: 180,
              useNativeDriver: true,
            }).start(() => onCloseRef.current())
          } else {
            Animated.spring(translateY, { toValue: 0, bounciness: 0, useNativeDriver: true }).start()
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, { toValue: 0, bounciness: 0, useNativeDriver: true }).start()
        },
      }),
    [translateY],
  )

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <Animated.View style={[s.sheet, { transform: [{ translateY }] }]}>
          <View {...pan.panHandlers} style={s.dragArea}>
            <View style={s.handle} />
            <Text style={[s.title, { fontSize: titleSize }]}>{title}</Text>
          </View>
          {children}
        </Animated.View>
      </View>
    </Modal>
  )
}

const s = StyleSheet.create({
  overlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet:    { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingBottom: 36, maxHeight: '90%' },
  dragArea: { paddingTop: 24, paddingBottom: 8 },
  handle:   { alignSelf: 'center', width: 36, height: 4, backgroundColor: C.line, borderRadius: 100, marginBottom: 20 },
  title:    { fontWeight: '800', color: C.text },
})
