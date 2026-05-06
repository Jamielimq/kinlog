import { LinearGradient } from 'expo-linear-gradient'
import { router, useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Dimensions,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { RARITY_COLOR } from '../../constants/rarity'
import { useWallet } from '../../context/WalletContext'
import { localDateKey } from '../../hooks/challengeProgress'
import { useChallenges } from '../../hooks/useChallenges'
import { useClaimChallengeReward } from '../../hooks/useClaimChallengeReward'
import { useGoals } from '../../hooks/useGoals'
import { useStartChallenge } from '../../hooks/useStartChallenge'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926', dark2: '#3A3532', dark3: '#57524E',
  amber: '#D97706', amber2: '#F59E0B', amber3: '#FCD34D', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
  red: '#EF4444', redBg: '#FEE2E2',
  green: '#10B981',
}

type CellState = 'met' | 'today' | 'missed' | 'future'

interface DayCell {
  day: number
  state: CellState
  reps: number
  key: string
}

function shortenSig(sig: string): string {
  if (!sig || sig.length < 12) return sig
  return `${sig.slice(0, 6)}...${sig.slice(-4)}`
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export default function ChallengeDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>()
  const id = typeof params.id === 'string' ? params.id : ''

  const { publicKey, connecting, connect } = useWallet()
  const address = publicKey?.toBase58() ?? null

  const { challenges, loading } = useChallenges(address)
  const { goals } = useGoals(address)
  const { startChallenge, isStarting } = useStartChallenge()
  const { claimChallengeReward, isClaiming } = useClaimChallengeReward()

  const [claimResult, setClaimResult] = useState<{ tx: string; points: number } | null>(null)

  const view = challenges.find(c => c.catalog.id === id)

  // Day grid cells — derived from instance.progress.daysLog or empty.
  const cells = useMemo<DayCell[]>(() => {
    if (!view) return []
    const { catalog, instance } = view
    const out: DayCell[] = []

    if (!instance) {
      for (let i = 1; i <= catalog.requirementDays; i++) {
        out.push({ day: i, state: 'future', reps: 0, key: '' })
      }
      return out
    }

    const todayKey = localDateKey(Date.now())
    const todayStart = startOfLocalDay(Date.now())
    const startDay = new Date(instance.startedAt)
    startDay.setHours(0, 0, 0, 0)

    for (let i = 0; i < catalog.requirementDays; i++) {
      const day = new Date(startDay)
      day.setDate(startDay.getDate() + i)
      const key = localDateKey(day.getTime())
      const log = instance.progress.daysLog?.[key]

      let state: CellState
      if (log?.met) state = 'met'
      else if (key === todayKey) state = 'today'
      else if (day.getTime() < todayStart) state = 'missed'
      else state = 'future'

      out.push({ day: i + 1, state, reps: log?.reps ?? 0, key })
    }
    return out
  }, [view])

  // ─── Loading / not found ───
  if (loading && !view) {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={s.centerFill}>
          <ActivityIndicator color={C.amber2} />
          <Text style={s.loadingText}>Loading quest...</Text>
        </View>
      </SafeAreaView>
    )
  }

  if (!view) {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        <Header onBack={() => router.back()} />
        <View style={s.centerFill}>
          <Text style={s.notFoundIcon}>🛡</Text>
          <Text style={s.notFoundTitle}>Quest not found</Text>
          <Text style={s.notFoundSub}>It may have been removed or the link is wrong.</Text>
          <TouchableOpacity style={s.notFoundBtn} onPress={() => router.back()} activeOpacity={0.85}>
            <Text style={s.notFoundBtnText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    )
  }

  const { catalog, instance, progressPct, daysRemaining } = view
  const status = instance?.status
  const rarityColor = RARITY_COLOR[catalog.rarity] ?? C.sub

  // Day grid layout — dynamic cell size for clean rows.
  const screenW = Dimensions.get('window').width
  const innerW = screenW - 40 // 20 padding × 2
  const cellsPerRow = catalog.requirementDays <= 7 ? catalog.requirementDays : 7
  const cellGap = 8
  const cellSize = Math.floor((innerW - cellGap * (cellsPerRow - 1)) / cellsPerRow)

  const statusLabel = !instance
    ? 'NOT STARTED'
    : status === 'active'
    ? 'ACTIVE'
    : status === 'completed'
    ? 'READY TO CLAIM'
    : status === 'failed'
    ? 'FAILED'
    : 'CLAIMED'

  // Today's status (active only) — uses daily goal as the live counter.
  const dailyGoal = goals.find(g => g.id === 'daily')
  const todayReps = dailyGoal?.current ?? 0
  const todayTarget = catalog.requirementDailyReps
  const todayPct = Math.min(todayReps / todayTarget, 1)
  const todayLog = instance?.progress.daysLog?.[localDateKey(Date.now())]
  const todayMet = !!todayLog?.met

  const handleStart = async () => {
    try {
      await startChallenge(catalog)
      // Stay on this screen — onSnapshot will populate the new instance.
    } catch {
      // Hook surfaces the error.
    }
  }

  const handleClaim = async () => {
    try {
      const { txSignature, awardedPoints } = await claimChallengeReward(view)
      setClaimResult({ tx: txSignature, points: awardedPoints })
    } catch {
      // Hook surfaces the error.
    }
  }

  const openSolscan = (sig: string) => {
    Linking.openURL(`https://solscan.io/tx/${sig}`)
  }

  // ─── Bottom action ───
  let bottom: { label: string; onPress: () => void; primary: boolean; disabled?: boolean }
  if (!publicKey) {
    bottom = { label: connecting ? 'Connecting...' : 'Connect Wallet', onPress: connect, primary: true, disabled: connecting }
  } else if (!instance) {
    bottom = { label: isStarting ? 'Starting...' : 'Start Quest', onPress: handleStart, primary: true, disabled: isStarting }
  } else if (status === 'active') {
    bottom = todayMet
      ? { label: "Today's goal done ✓", onPress: () => {}, primary: false, disabled: true }
      : { label: 'Go to Workout →', onPress: () => router.push('/workout'), primary: true }
  } else if (status === 'completed') {
    bottom = { label: isClaiming ? 'Claiming...' : 'Claim Reward →', onPress: handleClaim, primary: true, disabled: isClaiming }
  } else if (status === 'failed') {
    bottom = { label: isStarting ? 'Starting...' : 'Try Again', onPress: handleStart, primary: true, disabled: isStarting }
  } else {
    // claimed
    bottom = { label: isStarting ? 'Starting...' : 'Start Again', onPress: handleStart, primary: false, disabled: isStarting }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Header onBack={() => router.back()} />

        {/* Hero card with gradient */}
        <LinearGradient
          colors={[catalog.nft.gradientFrom, catalog.nft.gradientTo] as [string, string]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={s.hero}
        >
          <View style={s.heroTopRow}>
            <View style={s.heroBadge}>
              <Text style={s.heroBadgeText}>🛡  {catalog.nft.romanNumeral}</Text>
            </View>
            <View style={[s.rarityPill, { borderColor: rarityColor }]}>
              <View style={[s.rarityDot, { backgroundColor: rarityColor }]} />
              <Text style={[s.rarityText, { color: '#fff' }]}>{catalog.rarity.toUpperCase()}</Text>
            </View>
          </View>
          <Text style={s.heroName}>{catalog.name}</Text>
          <Text style={s.heroTagline}>{catalog.tagline}</Text>
          <View style={s.statusPill}>
            <Text style={s.statusPillText}>{statusLabel}</Text>
            {instance && (status === 'active' || status === 'completed' || status === 'failed') && (
              <Text style={s.statusPillSub}>
                {' · '}{Math.round(progressPct * 100)}%
              </Text>
            )}
          </View>
        </LinearGradient>

        {/* Requirements */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Requirements</Text>
          <View style={s.sectionCard}>
            <View style={s.reqRow}>
              <Text style={s.reqDot}>•</Text>
              <Text style={s.reqText}>
                <Text style={s.reqStrong}>{catalog.requirementDays} days</Text> · {catalog.requirementDailyReps} squats per day
              </Text>
            </View>
            <View style={s.reqRow}>
              <Text style={s.reqDot}>•</Text>
              <Text style={s.reqText}>
                Reward: <Text style={s.reqAmber}>+{catalog.bonusPoints.toLocaleString()} points</Text>
              </Text>
            </View>
            <View style={[s.reqRow, s.reqRowLast]}>
              <Text style={s.reqDot}>•</Text>
              <Text style={s.reqText}>
                Reward fee: {(catalog.mintFeeLamports / 1_000_000_000).toFixed(3)} SOL (charged on claim)
              </Text>
            </View>
          </View>
        </View>

        {/* Description */}
        {catalog.description ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Description</Text>
            <View style={s.sectionCard}>
              <Text style={s.desc}>{catalog.description}</Text>
            </View>
          </View>
        ) : null}

        {/* Daily Progress grid (active / completed / failed) */}
        {instance && status !== 'claimed' && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Daily Progress</Text>
            <View style={[s.daysGrid, { gap: cellGap }]}>
              {cells.map(cell => (
                <DayCellView key={cell.day} cell={cell} size={cellSize} />
              ))}
            </View>
            <View style={s.legend}>
              <LegendItem color={C.amber2} label="Done" />
              <LegendItem color={C.amberBg} borderColor={C.amber2} label="Today" />
              <LegendItem color={C.redBg} borderColor={C.red} label="Missed" />
              <LegendItem color={C.bg2} label="Future" />
            </View>
          </View>
        )}

        {/* Today's Status (active only) */}
        {status === 'active' && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>Today's Status</Text>
            <View style={s.todayCard}>
              <View style={s.todayTopRow}>
                <Text style={s.todayLabel}>TODAY</Text>
                <Text style={s.todayCount}>
                  <Text style={s.todayCountNum}>{todayReps}</Text>
                  <Text style={s.todayCountTarget}> / {todayTarget}</Text>
                </Text>
              </View>
              <View style={s.progressBar}>
                <View style={[s.progressFill, { width: `${todayPct * 100}%` }]} />
              </View>
              <Text style={s.todayNote}>
                {todayMet
                  ? '🎉 Daily target done!'
                  : `${Math.max(0, todayTarget - todayReps)} more squats to meet today`}
              </Text>
            </View>
            {daysRemaining !== null && daysRemaining > 0 && (
              <Text style={s.daysLeftHint}>
                {daysRemaining} day{daysRemaining > 1 ? 's' : ''} of consistency to go
              </Text>
            )}
          </View>
        )}

        {/* On-Chain Audit */}
        {instance && (
          <View style={s.section}>
            <Text style={s.sectionTitle}>On-Chain Audit</Text>
            <View style={s.auditCard}>
              <AuditRow label="Started" value={new Date(instance.startedAt).toLocaleDateString()} />
              <AuditRow
                label="Start Tx"
                value={shortenSig(instance.startTxSignature)}
                onPress={() => openSolscan(instance.startTxSignature)}
              />
              <AuditRow label="Memo" value={instance.startMemo} mono />
              {instance.claimedAt ? (
                <>
                  <AuditRow label="Claimed" value={new Date(instance.claimedAt).toLocaleDateString()} />
                  {instance.claimTxSignature ? (
                    <AuditRow
                      label="Claim Tx"
                      value={shortenSig(instance.claimTxSignature)}
                      onPress={() => openSolscan(instance.claimTxSignature!)}
                    />
                  ) : null}
                </>
              ) : null}
            </View>
          </View>
        )}

        {/* Bottom action */}
        <TouchableOpacity
          style={[
            bottom.primary ? s.actionPrimary : s.actionGhost,
            bottom.disabled && (bottom.primary ? s.actionPrimaryDisabled : s.actionGhostDisabled),
          ]}
          onPress={bottom.onPress}
          disabled={bottom.disabled}
          activeOpacity={0.85}
        >
          <Text style={[
            bottom.primary ? s.actionPrimaryText : s.actionGhostText,
            bottom.disabled && s.actionDisabledText,
          ]}>
            {bottom.label}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Claim success modal */}
      <Modal visible={!!claimResult} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <Text style={s.modalIcon}>🎉</Text>
            <Text style={s.modalTitle}>Reward Claimed!</Text>
            <Text style={s.modalPoints}>+{claimResult?.points.toLocaleString()} points</Text>
            <Text style={s.modalQuestName}>{catalog.name}</Text>
            {claimResult?.tx ? (
              <View style={s.modalTxBox}>
                <Text style={s.modalTxLabel}>TX</Text>
                <Text style={s.modalTxValue}>{shortenSig(claimResult.tx)}</Text>
              </View>
            ) : null}
            <TouchableOpacity
              style={s.modalSolscan}
              onPress={() => claimResult && openSolscan(claimResult.tx)}
              activeOpacity={0.85}
            >
              <Text style={s.modalSolscanText}>View on Solscan</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={s.modalDone}
              onPress={() => setClaimResult(null)}
              activeOpacity={0.85}
            >
              <Text style={s.modalDoneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  )
}

// ─────────── Subcomponents ───────────

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={onBack} style={s.backBtn} activeOpacity={0.7}>
        <Text style={s.backArrow}>←</Text>
      </TouchableOpacity>
    </View>
  )
}

function DayCellView({ cell, size }: { cell: DayCell; size: number }) {
  let bg = C.bg2
  let borderColor = 'transparent'
  let borderWidth = 0
  let numColor = C.muted
  let mark = ''
  let markColor = '#fff'

  if (cell.state === 'met') {
    bg = C.amber2; numColor = '#fff'; mark = '✓'
  } else if (cell.state === 'today') {
    bg = C.amberBg; borderColor = C.amber2; borderWidth = 2; numColor = C.amber
  } else if (cell.state === 'missed') {
    bg = C.redBg; borderColor = C.red; borderWidth = 1.5; numColor = C.red; mark = '✗'; markColor = C.red
  }

  return (
    <View style={[
      s.dayCell,
      { width: size, height: size + 4, backgroundColor: bg, borderColor, borderWidth },
    ]}>
      <Text style={[s.dayNum, { color: numColor }]}>{cell.day}</Text>
      {mark ? <Text style={[s.dayMark, { color: markColor }]}>{mark}</Text> : null}
    </View>
  )
}

function LegendItem({ color, borderColor, label }: { color: string; borderColor?: string; label: string }) {
  return (
    <View style={s.legendItem}>
      <View
        style={[
          s.legendSwatch,
          { backgroundColor: color },
          borderColor ? { borderWidth: 1.5, borderColor } : null,
        ]}
      />
      <Text style={s.legendText}>{label}</Text>
    </View>
  )
}

function AuditRow({
  label,
  value,
  mono,
  onPress,
}: {
  label: string
  value: string
  mono?: boolean
  onPress?: () => void
}) {
  const Wrap: any = onPress ? TouchableOpacity : View
  return (
    <Wrap style={s.auditRow} onPress={onPress} activeOpacity={0.7}>
      <Text style={s.auditLabel}>{label}</Text>
      <Text style={[s.auditValue, mono && s.auditMono, onPress && s.auditLink]} numberOfLines={1}>
        {value}{onPress ? '  ↗' : ''}
      </Text>
    </Wrap>
  )
}

const s = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: C.bg },
  scroll:        { flex: 1, paddingHorizontal: 20 },
  scrollContent: { paddingBottom: 32 },

  header:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  backBtn:   { width: 36, height: 36, borderRadius: 12, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  backArrow: { fontSize: 18, color: C.text, fontWeight: '700' },

  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, gap: 12 },
  loadingText: { fontSize: 12, color: C.muted },

  notFoundIcon:    { fontSize: 38, marginBottom: 4 },
  notFoundTitle:   { fontSize: 18, fontWeight: '800', color: C.text },
  notFoundSub:     { fontSize: 13, color: C.sub, textAlign: 'center', marginBottom: 12 },
  notFoundBtn:     { backgroundColor: C.dark, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24 },
  notFoundBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },

  // Hero
  hero:           { borderRadius: 24, padding: 22, marginBottom: 20, minHeight: 180, justifyContent: 'space-between', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.18, shadowRadius: 14, elevation: 6 },
  heroTopRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  heroBadge:      { backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 100, paddingHorizontal: 12, paddingVertical: 5 },
  heroBadgeText:  { fontSize: 12, color: '#fff', fontWeight: '800', letterSpacing: 0.5 },
  rarityPill:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 100, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1.5 },
  rarityDot:      { width: 6, height: 6, borderRadius: 3 },
  rarityText:     { fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  heroName:       { fontSize: 28, fontWeight: '900', color: '#fff', letterSpacing: -0.6, marginBottom: 4, textShadowColor: 'rgba(0,0,0,0.3)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
  heroTagline:    { fontSize: 13, color: 'rgba(255,255,255,0.85)', marginBottom: 16 },
  statusPill:     { alignSelf: 'flex-start', flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 100, paddingHorizontal: 12, paddingVertical: 6 },
  statusPillText: { fontSize: 10, color: '#fff', fontWeight: '900', letterSpacing: 1.5 },
  statusPillSub:  { fontSize: 10, color: 'rgba(255,255,255,0.85)', fontWeight: '700' },

  // Section
  section:      { marginBottom: 22 },
  sectionTitle: { fontSize: 11, color: C.sub, fontWeight: '800', letterSpacing: 1.2, marginBottom: 10, textTransform: 'uppercase' },

  // Requirements
  reqRow:     { flexDirection: 'row', gap: 8, marginBottom: 6 },
  reqRowLast: { marginBottom: 0 },
  reqDot:     { fontSize: 13, color: C.muted, lineHeight: 18 },
  reqText:    { fontSize: 13, color: C.sub, flex: 1, lineHeight: 18 },
  reqStrong:  { color: C.text, fontWeight: '700' },
  reqAmber:   { color: C.amber, fontWeight: '700' },

  // Description
  desc: { fontSize: 13, color: C.sub, lineHeight: 20 },

  // Generic section card (Requirements / Description wrapper)
  sectionCard: { backgroundColor: C.card, borderRadius: 16, borderWidth: 0.5, borderColor: C.line, paddingVertical: 14, paddingHorizontal: 16 },

  // Days grid
  daysGrid:     { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
  dayCell:      { borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },
  dayNum:       { fontSize: 11, fontWeight: '800' },
  dayMark:      { fontSize: 13, fontWeight: '900', marginTop: 2 },
  legend:       { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 },
  legendItem:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendSwatch: { width: 12, height: 12, borderRadius: 4 },
  legendText:   { fontSize: 10, color: C.muted, fontWeight: '600' },

  // Today's status
  todayCard:        { backgroundColor: C.card, borderRadius: 16, borderWidth: 1.5, borderColor: C.line, padding: 16 },
  todayTopRow:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  todayLabel:       { fontSize: 9, color: C.sub, letterSpacing: 1.2, fontWeight: '800' },
  todayCount:       { fontSize: 18 },
  todayCountNum:    { fontSize: 22, fontWeight: '900', color: C.text },
  todayCountTarget: { fontSize: 14, color: C.muted, fontWeight: '700' },
  progressBar:      { height: 6, backgroundColor: C.bg3, borderRadius: 100, marginBottom: 10, overflow: 'hidden' },
  progressFill:     { height: 6, backgroundColor: C.amber2, borderRadius: 100 },
  todayNote:        { fontSize: 11, color: C.sub },
  daysLeftHint:     { fontSize: 11, color: C.muted, marginTop: 8, textAlign: 'center' },

  // Audit
  auditCard:  { backgroundColor: C.card, borderRadius: 16, borderWidth: 1.5, borderColor: C.line, paddingHorizontal: 14, paddingVertical: 4 },
  auditRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.line },
  auditLabel: { fontSize: 11, color: C.sub, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  auditValue: { fontSize: 12, color: C.text, fontWeight: '600', flexShrink: 1, marginLeft: 12, textAlign: 'right' },
  auditMono:  { fontSize: 10, color: C.sub },
  auditLink:  { color: C.amber },

  // Bottom action
  actionPrimary:         { backgroundColor: C.amber2, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8, shadowColor: C.amber, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.3, shadowRadius: 14, elevation: 6 },
  actionPrimaryDisabled: { backgroundColor: C.bg3, shadowOpacity: 0 },
  actionPrimaryText:     { color: C.dark, fontSize: 15, fontWeight: '900', letterSpacing: 0.3 },
  actionGhost:           { backgroundColor: C.bg2, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8, borderWidth: 1.5, borderColor: C.line },
  actionGhostDisabled:   { opacity: 0.6 },
  actionGhostText:       { color: C.sub, fontSize: 14, fontWeight: '700' },
  actionDisabledText:    { color: C.muted },

  // Modal
  modalOverlay:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  modalBox:         { backgroundColor: C.card, borderRadius: 24, padding: 28, alignItems: 'center', width: '100%', shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.25, shadowRadius: 24, elevation: 12 },
  modalIcon:        { fontSize: 48, marginBottom: 4 },
  modalTitle:       { fontSize: 20, fontWeight: '900', color: C.text, marginBottom: 6 },
  modalPoints:      { fontSize: 28, fontWeight: '900', color: C.amber, marginBottom: 4 },
  modalQuestName:   { fontSize: 13, color: C.sub, marginBottom: 18 },
  modalTxBox:       { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.bg2, borderRadius: 100, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 18 },
  modalTxLabel:     { fontSize: 9, color: C.sub, fontWeight: '800', letterSpacing: 1 },
  modalTxValue:     { fontSize: 11, color: C.dark, fontWeight: '700' },
  modalSolscan:     { width: '100%', backgroundColor: C.dark, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 8 },
  modalSolscanText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  modalDone:        { width: '100%', backgroundColor: C.bg2, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  modalDoneText:    { color: C.text, fontSize: 14, fontWeight: '700' },
})
