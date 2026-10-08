import { getApp } from '@react-native-firebase/app'
import { doc, getFirestore, setDoc } from '@react-native-firebase/firestore'
import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { BadgeCard } from '../../components/badges/BadgeCard'
import { SignInGate } from '../../components/SignInGate'
import { useClaims } from '../../context/ClaimsContext'
import { useWallet } from '../../context/WalletContext'
import { useSkrStaking } from '../../hooks/useSkrStaking'
import { type CardCategory, cardCounts, sortCards } from '../../lib/badgeCards'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926', dark2: '#3A3532',
  amber: '#D97706', amber2: '#F59E0B', amber3: '#FCD34D', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
  red: '#EF4444',
}

// The category chips after All, in this order.
const CHIPS: { key: CardCategory; label: string }[] = [
  { key: 'monthly', label: 'Monthly' },
  { key: 'lockedin', label: 'Locked In' },
  { key: 'squats', label: 'Squats' },
  { key: 'streak', label: 'Streak' },
  { key: 'special', label: 'Special' },
  { key: 'challenge', label: 'Challenge' },
]

/**
 * Every badge: lifetime, monthly and Square, each claimed for 0.001 SOL through the flow Goals uses
 * too (context/ClaimsContext.tsx). A claim that goes through only changes its card; one that doesn't
 * gets a popup. The tiles count each card once: Ready (something to claim, or a claim being
 * checked), Earned (all claimed) or Locked.
 */
export default function BadgesScreen() {
  const { publicKey, shortAddress, connecting, connect, disconnect, dataAddress } = useWallet()
  const address = dataAddress
  const { cards, loading, claimingId, claim, recheck } = useClaims()
  const [showDisconnect, setShowDisconnect] = useState(false)
  const [activeTab, setActiveTab] = useState<'all' | CardCategory>('all')
  const { isStaker } = useSkrStaking(address)

  // Auto-award SKR Staker badge
  useEffect(() => {
    if (isStaker && address) {
      const db = getFirestore(getApp())
      setDoc(
        doc(db, 'users', address, 'badges', 'skr_staker'),
        { earned: true, earnedAt: Date.now() },
        { merge: true }
      )
    }
  }, [isStaker, address])

  // Coming back to Badges looks at claims sent earlier again (the tab stays mounted).
  useFocusEffect(
    useCallback(() => {
      void recheck()
    }, [recheck]),
  )

  const hasReady = (cat?: CardCategory) => cards.some(c => c.state === 'ready' && (!cat || c.category === cat))
  const TABS: { key: 'all' | CardCategory; label: string; dot: boolean }[] = [
    { key: 'all', label: `All (${cards.length})`, dot: hasReady() },
    ...CHIPS.map(chip => ({ ...chip, n: cards.filter(c => c.category === chip.key).length }))
      // Challenge has cards only for wallets that earned the old quest badges.
      .filter(chip => chip.n > 0)
      .map(chip => ({ key: chip.key, label: `${chip.label} (${chip.n})`, dot: hasReady(chip.key) })),
  ]
  // A chip that went away (another wallet) falls back to All.
  const tab = TABS.some(t => t.key === activeTab) ? activeTab : 'all'
  const shown = sortCards(tab === 'all' ? cards : cards.filter(c => c.category === tab))
  const counts = cardCounts(cards)
  // No numbers until everything is read, so no count flashes 0.
  const num = (n: number) => (loading ? ' ' : String(n))

  return (
    // Top edge only: the tab bar already covers the bottom inset (see app/(tabs)/index.tsx).
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.headerSub}>Collection</Text>
            <Text style={s.headerTitle}>My Badge Collection</Text>
          </View>
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

        <SignInGate />

        {/* Stats row */}
        <View style={s.statsRow}>
          <View style={s.statBox}>
            <Text style={s.statVal}>{num(counts.ready)}</Text>
            <View style={s.statLblRow}>
              <Text style={s.statLbl}>Ready</Text>
              {!loading && hasReady() && <View style={s.dot}/>}
            </View>
          </View>
          <View style={s.statDivider}/>
          <View style={s.statBox}>
            <Text style={s.statVal}>{num(counts.earned)}</Text>
            <Text style={s.statLbl}>Earned</Text>
          </View>
          <View style={s.statDivider}/>
          <View style={s.statBox}>
            <Text style={s.statVal}>{num(counts.locked)}</Text>
            <Text style={s.statLbl}>Locked</Text>
          </View>
          <View style={s.statDivider}/>
          <View style={s.statBox}>
            <Text style={s.statVal}>{num(counts.total)}</Text>
            <Text style={s.statLbl}>Total</Text>
          </View>
        </View>

        {/* Wallet card */}
        <TouchableOpacity style={s.walletCard} onPress={publicKey ? () => setShowDisconnect(true) : connect} activeOpacity={0.8}>
          <View style={[s.walletIndicator, { backgroundColor: publicKey ? C.amber2 : C.red }]}/>
          <View style={{ flex: 1 }}>
            <Text style={s.walletTitle}>{publicKey ? 'Solana Wallet Connected' : 'Wallet Not Connected'}</Text>
            <Text style={s.walletAddr}>{shortAddress ?? 'Connect to claim achievement points'}</Text>
          </View>
          <View style={s.walletBadge}>
            <Text style={s.walletBadgeText}>{publicKey ? 'Active' : 'Connect'}</Text>
          </View>
        </TouchableOpacity>

        {/* Category tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabScroll} contentContainerStyle={s.tabRow}>
          {TABS.map(t => (
            <TouchableOpacity
              key={t.key}
              style={[s.tab, tab === t.key && s.tabActive]}
              onPress={() => setActiveTab(t.key)}
              activeOpacity={0.8}
            >
              <View style={s.tabInner}>
                <Text style={[s.tabText, tab === t.key && s.tabTextActive]}>{t.label}</Text>
                {t.dot && <View style={s.dot}/>}
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Badge grid */}
        <View style={s.grid}>
          {shown.map(card => (
            <BadgeCard
              key={card.key}
              card={card}
              busy={claimingId !== null && card.claimIds.includes(claimingId)}
              disabled={loading || claimingId !== null}
              onClaim={() => {
                if (card.open[0]) void claim(card.open[0])
              }}
            />
          ))}
        </View>

        <View style={{ height: 24 }}/>
      </ScrollView>

      {/* Disconnect Modal */}
      <Modal visible={showDisconnect} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <View style={s.modalHandle}/>
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

  header:              { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 16, paddingBottom: 10 },
  headerSub:           { fontSize: 10, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  headerTitle:         { fontSize: 22, fontWeight: '800', color: C.text },
  walletBtn:           { backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletBtnText:       { color: '#fff', fontSize: 12, fontWeight: '700' },
  walletConnected:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletDot:           { width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber2 },
  walletConnectedText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  statsRow:    { flexDirection: 'row', backgroundColor: C.card, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1.5, borderColor: C.line, alignItems: 'flex-start' },
  statBox:     { flex: 1, alignItems: 'center' },
  statVal:     { fontSize: 22, fontWeight: '900', color: C.text, marginBottom: 2 },
  statLbl:     { fontSize: 9, color: C.muted, letterSpacing: 0.5, textTransform: 'uppercase' },
  statLblRow:  { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statDivider: { width: 1, height: 32, backgroundColor: C.line },

  walletCard:      { backgroundColor: C.dark, borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  walletIndicator: { width: 10, height: 10, borderRadius: 5 },
  walletTitle:     { fontSize: 13, fontWeight: '600', color: '#fff' },
  walletAddr:      { fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 },
  walletBadge:     { backgroundColor: `${C.amber}22`, borderWidth: 1, borderColor: `${C.amber}44`, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 100 },
  walletBadgeText: { fontSize: 11, fontWeight: '700', color: C.amber2 },

  tabScroll:  { marginBottom: 16 },
  tabRow:     { flexDirection: 'row', gap: 8, paddingRight: 20 },
  tab:        { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 100, backgroundColor: C.bg2, borderWidth: 1.5, borderColor: C.line },
  tabActive:  { backgroundColor: C.dark, borderColor: C.dark },
  tabInner:   { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tabText:    { fontSize: 12, fontWeight: '600', color: C.sub },
  tabTextActive: { color: '#fff' },
  // Something to claim: on a chip and on the Ready tile, as on the tab icon.
  dot:        { width: 6, height: 6, borderRadius: 3, backgroundColor: C.red },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 },

  modalOverlay:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalBox:            { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 40, alignItems: 'center' },
  modalHandle:         { width: 36, height: 4, backgroundColor: C.line, borderRadius: 100, marginBottom: 24 },
  modalTitle:          { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 6 },
  modalAddr:           { fontSize: 12, color: C.muted, backgroundColor: C.bg2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100, marginBottom: 16, fontWeight: '600' },
  modalDesc:           { fontSize: 13, color: C.sub, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  modalDisconnect:     { width: '100%', backgroundColor: C.dark, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  modalDisconnectText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  modalCancel:         { width: '100%', backgroundColor: C.bg2, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  modalCancelText:     { color: C.text, fontSize: 15, fontWeight: '600' },
})
