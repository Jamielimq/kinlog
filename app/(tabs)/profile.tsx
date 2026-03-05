import { useState } from 'react'
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWallet } from '../../context/WalletContext'
import { useBadges } from '../../hooks/useBadges'
import { usePoints } from '../../hooks/usePoints'
import { useUserStats } from '../../hooks/useUserStats'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926', dark2: '#3A3532',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

function getActivityIcon(reason: string) {
  if (reason.toLowerCase().includes('minted') || reason.toLowerCase().includes('nft')) return '✦'
  if (reason.toLowerCase().includes('streak')) return '🔥'
  if (reason.toLowerCase().includes('badge')) return '🏅'
  return '🏋️'
}

export default function ProfileScreen() {
  const { publicKey, shortAddress, connecting, connect, disconnect } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { stats } = useUserStats(address)
  const { badges } = useBadges(address)
  const { history } = usePoints(address)
  const [showDisconnect, setShowDisconnect] = useState(false)
  const [activeModal, setActiveModal] = useState<'workout' | 'points' | null>(null)

  const formattedPoints = stats.points.toLocaleString()
  const mintedBadges = badges.filter(b => b.mintedAt).length

  const STATS = [
    { label: 'Total Points',   value: formattedPoints,        color: C.amber  },
    { label: 'Total Workouts', value: `${stats.totalWorkouts}`, color: C.dark2 },
    { label: 'NFT Badges',     value: `${mintedBadges}`,       color: C.dark2 },
    { label: 'Best Streak',    value: `${stats.bestStreak}d`,  color: C.dark2 },
  ]

  // workout 기록만 필터 (squats completed)
  const workoutHistory = history.filter(h => h.reason.toLowerCase().includes('squat'))
  // 포인트 전체 기록
  const pointsHistory = history

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <Text style={s.headerTitle}>Profile</Text>
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

        {/* Profile Card */}
        <View style={s.profileCard}>
          <View style={s.avatarWrap}>
            <Text style={s.avatarText}>K</Text>
          </View>
          <Text style={s.profileName}>Kinlog User</Text>
          <Text style={s.profileRole}>{shortAddress ?? 'Wallet not connected'}</Text>
          <View style={s.badgeRow}>
            {publicKey ? (
              <>
                <View style={s.badgeAmber}><Text style={s.badgeAmberText}>✦ {formattedPoints} Points</Text></View>
                {stats.currentStreak > 0 && (
                  <View style={s.badgeAmber}><Text style={s.badgeAmberText}>🔥 {stats.currentStreak}d Streak</Text></View>
                )}
              </>
            ) : (
              <View style={s.badge}><Text style={s.badgeText}>Connect wallet to earn points</Text></View>
            )}
          </View>
        </View>

        {/* Stats Grid */}
        <View style={s.statsGrid}>
          {STATS.map(stat => (
            <View key={stat.label} style={s.statCard}>
              <Text style={[s.statValue, { color: stat.color }]}>{stat.value}</Text>
              <Text style={s.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>

        {/* Wallet Card */}
        <TouchableOpacity style={s.walletCard} onPress={publicKey ? () => setShowDisconnect(true) : connect} activeOpacity={0.8}>
          <Text style={s.walletHeader}>SOLANA WALLET</Text>
          <View style={s.walletRow}>
            <View style={[s.walletIndicator, { backgroundColor: publicKey ? C.amber2 : '#EF4444' }]}/>
            <View style={{ flex: 1 }}>
              <Text style={s.walletAddr}>{shortAddress ?? 'Not Connected'}</Text>
              <Text style={s.walletBal}>{publicKey ? 'Balance: -- SOL' : 'Not Connected'}</Text>
            </View>
            <View style={s.connectedBadge}>
              <Text style={s.connectedText}>{publicKey ? 'Connected' : 'Disconnected'}</Text>
            </View>
          </View>
        </TouchableOpacity>

        {/* Menu - Workout History */}
        <TouchableOpacity style={[s.menuRow, s.menuBorder]} onPress={() => setActiveModal('workout')} activeOpacity={0.7}>
          <View style={s.menuIcon}><Text style={s.menuIconText}>◎</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.menuLabel}>Workout History</Text>
            <Text style={s.menuSub}>View all records</Text>
          </View>
          <Text style={s.menuArrow}>›</Text>
        </TouchableOpacity>

        {/* Menu - Points Log */}
        <TouchableOpacity style={s.menuRow} onPress={() => setActiveModal('points')} activeOpacity={0.7}>
          <View style={s.menuIcon}><Text style={s.menuIconText}>◈</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.menuLabel}>Points Log</Text>
            <Text style={s.menuSub}>Earned & spent</Text>
          </View>
          <Text style={s.menuArrow}>›</Text>
        </TouchableOpacity>

        <View style={{ height: 24 }}/>
      </ScrollView>

      {/* Workout History Modal */}
      <Modal visible={activeModal === 'workout'} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            <View style={s.modalHandle}/>
            <Text style={s.modalTitle}>Workout History</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {workoutHistory.length === 0 ? (
                <View style={s.emptyState}>
                  <Text style={s.emptyText}>No workouts yet. Start your first session!</Text>
                </View>
              ) : (
                workoutHistory.map((item, i) => (
                  <View key={item.id ?? i} style={[s.historyRow, i < workoutHistory.length - 1 && s.historyBorder]}>
                    <View style={s.historyIcon}>
                      <Text style={{ fontSize: 17 }}>🏋️</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.historyLabel}>{item.reason}</Text>
                      <Text style={s.historyTime}>{new Date(item.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
                    </View>
                    <Text style={s.historyPts}>+{item.amount} pts</Text>
                  </View>
                ))
              )}
              <View style={{ height: 20 }}/>
            </ScrollView>
            <TouchableOpacity style={s.modalCloseBtn} onPress={() => setActiveModal(null)}>
              <Text style={s.modalCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Points Log Modal */}
      <Modal visible={activeModal === 'points'} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            <View style={s.modalHandle}/>
            <Text style={s.modalTitle}>Points Log</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {pointsHistory.length === 0 ? (
                <View style={s.emptyState}>
                  <Text style={s.emptyText}>No points earned yet.</Text>
                </View>
              ) : (
                pointsHistory.map((item, i) => (
                  <View key={item.id ?? i} style={[s.historyRow, i < pointsHistory.length - 1 && s.historyBorder]}>
                    <View style={s.historyIcon}>
                      <Text style={{ fontSize: 17 }}>{getActivityIcon(item.reason)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.historyLabel}>{item.reason}</Text>
                      <Text style={s.historyTime}>{new Date(item.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}</Text>
                    </View>
                    <Text style={s.historyPts}>+{item.amount}</Text>
                  </View>
                ))
              )}
              <View style={{ height: 20 }}/>
            </ScrollView>
            <TouchableOpacity style={s.modalCloseBtn} onPress={() => setActiveModal(null)}>
              <Text style={s.modalCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Disconnect Modal */}
      <Modal visible={showDisconnect} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <View style={s.modalHandle}/>
            <Text style={s.modalTitle}>Disconnect Wallet?</Text>
            <Text style={s.modalAddr}>{shortAddress}</Text>
            <Text style={s.modalDesc}>Disconnecting your wallet will disable points earning and NFT badge features.</Text>
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

  header:              { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16 },
  headerTitle:         { fontSize: 22, fontWeight: '800', color: C.text },
  walletBtn:           { backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletBtnText:       { color: '#fff', fontSize: 12, fontWeight: '700' },
  walletConnected:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletDot:           { width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber2 },
  walletConnectedText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  profileCard:    { backgroundColor: C.dark, borderRadius: 24, padding: 24, marginBottom: 16, alignItems: 'center' },
  avatarWrap:     { width: 72, height: 72, borderRadius: 36, backgroundColor: C.dark2, borderWidth: 2, borderColor: `${C.amber}66`, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  avatarText:     { fontSize: 28, fontWeight: '800', color: C.amber2 },
  profileName:    { fontSize: 20, fontWeight: '800', color: '#fff', marginBottom: 4 },
  profileRole:    { fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 14 },
  badgeRow:       { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  badgeAmber:     { backgroundColor: `${C.amber}22`, borderWidth: 1, borderColor: `${C.amber}44`, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 100 },
  badgeAmberText: { fontSize: 11, fontWeight: '700', color: C.amber2 },
  badge:          { backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 100 },
  badgeText:      { fontSize: 11, color: 'rgba(255,255,255,0.6)' },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 },
  statCard:  { width: '47.5%', backgroundColor: C.card, borderRadius: 18, padding: 16, borderWidth: 1.5, borderColor: C.line },
  statValue: { fontSize: 24, fontWeight: '900', marginBottom: 6 },
  statLabel: { fontSize: 9, color: C.muted, letterSpacing: 0.5, textTransform: 'uppercase' },

  walletCard:      { backgroundColor: C.dark, borderRadius: 16, padding: 16, marginBottom: 16 },
  walletHeader:    { fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: 1.5, marginBottom: 12 },
  walletRow:       { flexDirection: 'row', alignItems: 'center', gap: 12 },
  walletIndicator: { width: 10, height: 10, borderRadius: 5 },
  walletAddr:      { fontSize: 13, fontWeight: '600', color: '#fff' },
  walletBal:       { fontSize: 11, color: 'rgba(255,255,255,0.35)', marginTop: 2 },
  connectedBadge:  { backgroundColor: `${C.amber}22`, borderWidth: 1, borderColor: `${C.amber}44`, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 100 },
  connectedText:   { fontSize: 11, fontWeight: '700', color: C.amber2 },

  menuRow:      { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  menuBorder:   { borderBottomWidth: 1, borderBottomColor: C.line },
  menuIcon:     { width: 42, height: 42, borderRadius: 13, backgroundColor: C.amberBg, borderWidth: 1.5, borderColor: `${C.amber}22`, alignItems: 'center', justifyContent: 'center' },
  menuIconText: { fontSize: 16, color: C.amber2 },
  menuLabel:    { fontSize: 13, fontWeight: '600', color: C.text },
  menuSub:      { fontSize: 10, color: C.muted, marginTop: 2 },
  menuArrow:    { fontSize: 20, color: C.muted },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet:   { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 16, maxHeight: '75%' },
  modalBox:     { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 40, alignItems: 'center' },
  modalHandle:  { width: 36, height: 4, backgroundColor: C.line, borderRadius: 100, marginBottom: 20, alignSelf: 'center' },
  modalTitle:   { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 16 },
  modalAddr:    { fontSize: 12, color: C.muted, backgroundColor: C.bg2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100, marginBottom: 16, fontWeight: '600' },
  modalDesc:    { fontSize: 13, color: C.sub, textAlign: 'center', lineHeight: 20, marginBottom: 24 },

  historyRow:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  historyBorder: { borderBottomWidth: 1, borderBottomColor: C.line },
  historyIcon:   { width: 40, height: 40, borderRadius: 13, backgroundColor: C.bg2, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: C.line },
  historyLabel:  { fontSize: 12, fontWeight: '600', color: C.text },
  historyTime:   { fontSize: 10, color: C.muted, marginTop: 2 },
  historyPts:    { fontSize: 12, fontWeight: '800', color: C.amber2 },

  emptyState:  { paddingVertical: 32, alignItems: 'center' },
  emptyText:   { fontSize: 12, color: C.muted, textAlign: 'center' },

  modalCloseBtn:     { backgroundColor: C.dark, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  modalCloseBtnText: { color: C.amber2, fontSize: 14, fontWeight: '700' },
  modalDisconnect:     { width: '100%', backgroundColor: C.dark, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  modalDisconnectText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  modalCancel:         { width: '100%', backgroundColor: C.bg2, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  modalCancelText:     { color: C.text, fontSize: 15, fontWeight: '600' },
})
