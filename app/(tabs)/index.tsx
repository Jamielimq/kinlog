import { router } from 'expo-router'
import { useState } from 'react'
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWallet } from '../../context/WalletContext'
import { useGoals } from '../../hooks/useGoals'
import { usePoints } from '../../hooks/usePoints'
import { useUserStats } from '../../hooks/useUserStats'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926', dark2: '#3A3532', dark3: '#57524E',
  amber: '#D97706', amber2: '#F59E0B', amber3: '#FCD34D', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

function getGreeting() {
  const h = new Date().getHours()
  if (h < 6) return 'LATE NIGHT'
  if (h < 12) return 'GOOD MORNING'
  if (h < 18) return 'GOOD AFTERNOON'
  return 'GOOD EVENING'
}

function getActivityIcon(reason: string) {
  const r = reason.toLowerCase()
  if (r.includes('claimed') || r.includes('minted') || r.includes('nft')) return '✦'
  if (r.includes('streak')) return '🔥'
  if (r.includes('badge')) return '🏅'
  return '🏋️'
}

export default function HomeScreen() {
  const { publicKey, shortAddress, connecting, connect, disconnect } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { history } = usePoints(address)
  const { goals } = useGoals(address)
  const { stats } = useUserStats(address)
  const [showDisconnect, setShowDisconnect] = useState(false)

  const dailyGoal = goals.find(g => g.id === 'daily')
  const weeklyGoal = goals.find(g => g.id === 'weekly')
  const reps = dailyGoal?.current ?? 0
  const target = dailyGoal?.total ?? 30
  const progress = Math.min(reps / target, 1)

  const formattedPoints = stats.points.toLocaleString()
  const streakDisplay = stats.currentStreak > 0 ? `${stats.currentStreak}d` : '0d'

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <Text style={s.logo}>
            <Text style={{ color: C.dark }}>Kin</Text>
            <Text style={{ color: C.amber2 }}>log</Text>
          </Text>
          {publicKey ? (
            <TouchableOpacity style={s.walletConnected} onPress={() => setShowDisconnect(true)}>
              <View style={s.walletDot}/>
              <Text style={s.walletConnectedText}>{shortAddress}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.walletBtn} onPress={connect} disabled={connecting}>
              <Text style={s.walletBtnText}>{connecting ? 'Connecting...' : 'Connect Wallet'}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Greeting */}
        <View style={s.greet}>
          <Text style={s.greetSub}>{getGreeting()}</Text>
          <Text style={s.greetTitle}>Ready to move?</Text>
        </View>

        {/* Today's Progress Card */}
        <View style={s.progressCard}>
          <View style={s.progressTop}>
            <View>
              <Text style={s.progressLabel}>TODAY'S PROGRESS</Text>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
                <Text style={s.progressReps}>{reps}</Text>
                <Text style={s.progressTarget}>/ {target}</Text>
              </View>
              <Text style={s.progressExercise}>squats</Text>
            </View>
          </View>
          <View style={s.progressBar}>
            <View style={[s.progressFill, { width: `${progress * 100}%` }]}/>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={s.progressNote}>
              {reps >= target ? '🎉 Goal reached!' : `${target - reps} more to hit your goal`}
            </Text>
            <Text style={s.progressPct}>{Math.round(progress * 100)}%</Text>
          </View>
        </View>

        {/* Stats Row */}
        <View style={s.statsRow}>
          {[
            { label: 'Points',    value: formattedPoints, accent: true  },
            { label: 'Streak',    value: streakDisplay,   accent: false },
            { label: 'This Week', value: weeklyGoal ? `${weeklyGoal.current}/7` : '0/7', accent: false },
          ].map(stat => (
            <View key={stat.label} style={[s.statCard, stat.accent && s.statCardAccent]}>
              <Text style={[s.statValue, stat.accent && s.statValueAccent]}>{stat.value}</Text>
              <Text style={[s.statLabel, stat.accent && s.statLabelAccent]}>{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Start Button */}
        <TouchableOpacity style={s.startBtn} onPress={() => router.push('/workout')} activeOpacity={0.85}>
          <View style={{ flex: 1 }}>
            <Text style={s.startBtnLabel}>TODAY'S EXERCISE</Text>
            <Text style={s.startBtnExercise}>SQUAT</Text>
            <Text style={s.startBtnTitle}>Start Session</Text>
            <Text style={s.startBtnSub}>
              {reps >= target ? 'Goal complete! Come back tomorrow 💪' : `${target - reps} squats remaining today`}
            </Text>
          </View>
          <View style={s.startBtnIcon}>
            <Text style={{ color: C.amber2, fontSize: 18 }}>▶</Text>
          </View>
        </TouchableOpacity>

        {/* Recent Activity */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Recent Activity</Text>
          {!publicKey ? (
            <View style={s.emptyState}>
              <Text style={s.emptyText}>Connect your wallet to see activity</Text>
            </View>
          ) : history.length === 0 ? (
            <View style={s.emptyState}>
              <Text style={s.emptyText}>No activity yet. Start your first workout!</Text>
            </View>
          ) : (
            history.slice(0, 3).map((item, i) => (
              <View key={item.id ?? i} style={[s.activityRow, i < 2 && s.activityBorder]}>
                <View style={s.activityIcon}>
                  <Text style={{ fontSize: 17 }}>{getActivityIcon(item.reason)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.activityLabel}>{item.reason}</Text>
                  <Text style={s.activityTime}>{new Date(item.createdAt).toLocaleDateString()}</Text>
                </View>
                <Text style={s.activityPts}>+{item.amount}</Text>
              </View>
            ))
          )}
        </View>

      </ScrollView>

      {/* Disconnect Modal */}
      <Modal visible={showDisconnect} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <View style={s.modalDot}/>
            <Text style={s.modalTitle}>Disconnect Wallet?</Text>
            <Text style={s.modalAddr}>{shortAddress}</Text>
            <Text style={s.modalDesc}>Disconnecting your wallet will disable points earning and on-chain achievement records.</Text>
            <TouchableOpacity style={s.modalDisconnect} onPress={() => { disconnect(); setShowDisconnect(false) }}>
              <Text style={s.modalDisconnectText}>Disconnect</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.modalCancel} onPress={() => setShowDisconnect(false)}>
              <Text style={s.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1, paddingHorizontal: 20 },

  header:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16 },
  logo:               { fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  walletBtn:          { backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletBtnText:      { color: '#fff', fontSize: 12, fontWeight: '700' },
  walletConnected:    { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletDot:          { width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber2 },
  walletConnectedText:{ color: '#fff', fontSize: 12, fontWeight: '700' },

  greet:      { paddingBottom: 14 },
  greetSub:   { fontSize: 11, color: C.muted, letterSpacing: 1.2, marginBottom: 4 },
  greetTitle: { fontSize: 26, color: C.text, fontWeight: '800', letterSpacing: -0.8 },

  progressCard:     { backgroundColor: C.dark, borderRadius: 24, padding: 22, marginBottom: 14 },
  progressTop:      { marginBottom: 16 },
  progressLabel:    { fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: 1.2, marginBottom: 6 },
  progressReps:     { fontSize: 52, color: '#fff', fontWeight: '900', lineHeight: 56 },
  progressTarget:   { fontSize: 15, color: 'rgba(255,255,255,0.35)', marginBottom: 8 },
  progressExercise: { fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 },
  progressBar:      { height: 5, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 100, marginBottom: 10, overflow: 'hidden' },
  progressFill:     { height: 5, backgroundColor: C.amber2, borderRadius: 100 },
  progressNote:     { fontSize: 10, color: 'rgba(255,255,255,0.35)' },
  progressPct:      { fontSize: 10, fontWeight: '700', color: C.amber2 },

  statsRow:        { flexDirection: 'row', gap: 10, marginBottom: 14 },
  statCard:        { flex: 1, backgroundColor: C.card, borderRadius: 18, padding: 14, borderWidth: 1.5, borderColor: C.line },
  statCardAccent:  { backgroundColor: C.amberBg, borderColor: `${C.amber}33` },
  statValue:       { fontSize: 20, fontWeight: '800', color: C.text, marginBottom: 4 },
  statValueAccent: { color: C.amber },
  statLabel:       { fontSize: 9, color: C.muted, letterSpacing: 0.5, textTransform: 'uppercase' },
  statLabelAccent: { color: C.amber },

  startBtn:         { backgroundColor: C.amber2, borderRadius: 18, padding: 18, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, shadowColor: C.amber, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 8 },
  startBtnLabel:    { fontSize: 9, color: `${C.dark}66`, letterSpacing: 1.5, marginBottom: 2 },
  startBtnExercise: { fontSize: 28, fontWeight: '900', color: C.dark, letterSpacing: -0.5, marginBottom: 4 },
  startBtnTitle:    { fontSize: 16, fontWeight: '800', color: C.dark, marginBottom: 2 },
  startBtnSub:      { fontSize: 11, color: `${C.dark}99` },
  startBtnIcon:     { width: 44, height: 44, borderRadius: 22, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center' },

  section:       { marginBottom: 24 },
  sectionTitle:  { fontSize: 14, fontWeight: '800', color: C.text, marginBottom: 12 },
  activityRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  activityBorder:{ borderBottomWidth: 1, borderBottomColor: C.line },
  activityIcon:  { width: 40, height: 40, borderRadius: 13, backgroundColor: C.bg2, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: C.line },
  activityLabel: { fontSize: 12, fontWeight: '600', color: C.text },
  activityTime:  { fontSize: 10, color: C.muted, marginTop: 2 },
  activityPts:   { fontSize: 12, fontWeight: '800', color: C.amber2 },

  emptyState:    { paddingVertical: 20, alignItems: 'center' },
  emptyText:     { fontSize: 12, color: C.muted, textAlign: 'center' },

  modalOverlay:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalBox:            { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 40, alignItems: 'center' },
  modalDot:            { width: 36, height: 4, backgroundColor: C.line, borderRadius: 100, marginBottom: 24 },
  modalTitle:          { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 6 },
  modalAddr:           { fontSize: 12, color: C.muted, backgroundColor: C.bg2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100, marginBottom: 16, fontWeight: '600' },
  modalDesc:           { fontSize: 13, color: C.sub, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  modalDisconnect:     { width: '100%', backgroundColor: C.dark, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  modalDisconnectText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  modalCancel:         { width: '100%', backgroundColor: C.bg2, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  modalCancelText:     { color: C.text, fontSize: 15, fontWeight: '600' },
})
