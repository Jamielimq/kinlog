import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useWallet } from '../context/WalletContext'

const C = {
  card: '#FFFFFF', dark: '#2D2926',
  amber: '#D97706', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', red: '#B91C1C',
}

// Shown once connecting has finished and the wallet still has no Firebase session (an update
// from 1.3.3, a reinstall, or a sign-in that failed). Its data stays out of reach until it signs in.
export function SignInGate() {
  const { awaitingSignIn, session, signIn, signInError } = useWallet()
  if (!awaitingSignIn) return null
  const busy = session === 'signingIn'

  return (
    <View style={s.card}>
      <Text style={s.title}>Sign in to continue</Text>
      <Text style={s.body}>
        Sign in with your wallet to save workouts and see your progress. Signing in does not send a
        transaction.
      </Text>
      {signInError && !busy ? <Text style={s.error}>{signInError}</Text> : null}
      <TouchableOpacity style={s.btn} onPress={signIn} disabled={busy} activeOpacity={0.85}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Sign in</Text>}
      </TouchableOpacity>
    </View>
  )
}

const s = StyleSheet.create({
  card:    { backgroundColor: C.amberBg, borderRadius: 18, padding: 18, marginBottom: 14, borderWidth: 1.5, borderColor: `${C.amber}33` },
  title:   { fontSize: 16, fontWeight: '800', color: C.text, marginBottom: 6 },
  body:    { fontSize: 13, color: C.sub, lineHeight: 19, marginBottom: 12 },
  error:   { fontSize: 12, color: C.red, marginBottom: 12 },
  btn:     { backgroundColor: C.dark, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  btnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
})
