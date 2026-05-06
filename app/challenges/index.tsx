import { LinearGradient } from 'expo-linear-gradient'
import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWallet } from '../../context/WalletContext'
import { useChallenges, type ChallengeView } from '../../hooks/useChallenges'
import { useStartChallenge } from '../../hooks/useStartChallenge'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926', dark2: '#3A3532', dark3: '#57524E',
  amber: '#D97706', amber2: '#F59E0B', amber3: '#FCD34D', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

function tierOf(c: ChallengeView): number {
  if (c.instance?.status === 'completed') return 0
  if (c.instance?.status === 'active')    return 1
  if (!c.instance || c.instance.status === 'failed') return 2
  return 3 // claimed
}

export default function ChallengesScreen() {
  const { publicKey, connecting, connect } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { challenges, loading } = useChallenges(address)
  const { startChallenge } = useStartChallenge()
  const [startingId, setStartingId] = useState<string | null>(null)

  const sorted = useMemo(
    () => [...challenges].sort((a, b) => tierOf(a) - tierOf(b)),
    [challenges],
  )

  const summary = useMemo(() => {
    let inProg = 0, claimed = 0, available = 0
    for (const c of challenges) {
      const st = c.instance?.status
      if (st === 'active' || st === 'completed') inProg++
      else if (st === 'claimed') claimed++
      else available++ // no instance or failed
    }
    return { inProg, claimed, available }
  }, [challenges])

  const totalRewards = useMemo(
    () => challenges.reduce((sum, c) => sum + c.catalog.bonusPoints, 0),
    [challenges],
  )

  const handleStart = async (cv: ChallengeView) => {
    setStartingId(cv.catalog.id)
    try {
      await startChallenge(cv.catalog)
      router.push(`/challenges/${cv.catalog.id}`)
    } catch {
      // Hook surfaces the error via Alert.
    } finally {
      setStartingId(null)
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
            <Text style={s.backArrow}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Quests</Text>
            <Text style={s.subtitle}>Earn verified rewards</Text>
          </View>
        </View>

        {/* Connect CTA (disconnected) or Summary (connected) */}
        {!publicKey ? (
          <View style={s.connectCard}>
            <Text style={s.connectMain}>🛡  Connect wallet to start quests</Text>
            <View style={s.connectInfoRow}>
              <View style={s.connectInfoCol}>
                <Text style={s.connectInfoLabel}>AVAILABLE</Text>
                <Text style={s.connectInfoValue}>
                  {challenges.length} quest{challenges.length === 1 ? '' : 's'}
                </Text>
              </View>
              <View style={s.connectInfoDivider} />
              <View style={s.connectInfoCol}>
                <Text style={s.connectInfoLabel}>TOTAL REWARDS</Text>
                <Text style={s.connectInfoValue}>
                  {totalRewards.toLocaleString()} pts
                </Text>
              </View>
            </View>
            <TouchableOpacity
              style={[s.connectBtn, connecting && s.connectBtnLoading]}
              onPress={connect}
              disabled={connecting}
              activeOpacity={0.85}
            >
              <Text style={s.connectBtnText}>
                {connecting ? 'Connecting...' : 'Connect Wallet'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.summary}>
            <Text style={s.summaryText}>
              <Text style={s.summaryNum}>{summary.inProg}</Text> active
              <Text style={s.summarySep}>  ·  </Text>
              <Text style={s.summaryNum}>{summary.claimed}</Text> claimed
              <Text style={s.summarySep}>  ·  </Text>
              <Text style={s.summaryNum}>{summary.available}</Text> available
            </Text>
          </View>
        )}

        {/* Quest cards */}
        {loading && challenges.length === 0 ? (
          <View style={s.loadingState}>
            <ActivityIndicator color={C.amber2} />
            <Text style={s.loadingText}>Loading quests...</Text>
          </View>
        ) : challenges.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={s.emptyText}>No quests available right now</Text>
          </View>
        ) : (
          sorted.map(cv => (
            <QuestCard
              key={cv.catalog.id}
              cv={cv}
              walletConnected={!!publicKey}
              starting={startingId === cv.catalog.id}
              onStart={() => handleStart(cv)}
              onView={() => router.push(`/challenges/${cv.catalog.id}`)}
            />
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

interface QuestCardProps {
  cv: ChallengeView
  walletConnected: boolean
  starting: boolean
  onStart: () => void
  onView: () => void
}

function QuestCard({ cv, walletConnected, starting, onStart, onView }: QuestCardProps) {
  const { catalog, instance, progressPct } = cv
  const status = instance?.status

  const badgeNeutral = (
    <View style={s.questBadge}>
      <Text style={s.questBadgeText}>🛡 {catalog.nft.romanNumeral}</Text>
    </View>
  )

  // ─── Available (no instance) or Failed (retryable) ───
  if (!instance || status === 'failed') {
    const isFailed = status === 'failed'
    const startDisabled = !walletConnected || starting

    return (
      <View style={[s.cardBase, isFailed && s.cardDim]}>
        {isFailed && <View style={s.stripFailed} />}
        <View style={s.cardBody}>
          <View style={s.cardHead}>
            <View style={{ flex: 1 }}>
              {isFailed && <Text style={s.statusFailed}>✗ FAILED</Text>}
              <Text style={s.questName}>{catalog.name}</Text>
              <Text style={s.questTagline}>
                {isFailed ? 'Missed a day · Try again' : catalog.tagline}
              </Text>
            </View>
            {badgeNeutral}
          </View>
          <Text style={s.questReq}>
            {catalog.requirementDays} days · {catalog.requirementDailyReps} squats/day
          </Text>
          <Text style={s.questReward}>
            Reward: +{catalog.bonusPoints.toLocaleString()} points
          </Text>
          <TouchableOpacity
            style={[
              isFailed ? s.btnOutline : s.btnPrimary,
              startDisabled && (isFailed ? s.btnOutlineDisabled : s.btnPrimaryDisabled),
            ]}
            onPress={onStart}
            disabled={startDisabled}
            activeOpacity={0.85}
          >
            <Text
              style={[
                isFailed ? s.btnOutlineText : s.btnPrimaryText,
                startDisabled && s.btnDisabledText,
              ]}
            >
              {starting
                ? 'Starting...'
                : isFailed
                ? 'Try Again'
                : !walletConnected
                ? 'Start Quest'
                : 'Start Quest →'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    )
  }

  // ─── Active ───
  if (status === 'active') {
    const metCount = Object.values(instance.progress.daysLog ?? {}).filter(d => d.met).length
    return (
      <TouchableOpacity style={s.cardActiveWrap} onPress={onView} activeOpacity={0.85}>
        <LinearGradient
          colors={[catalog.nft.gradientFrom, catalog.nft.gradientTo] as [string, string]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={s.cardActive}
        >
          <View style={s.cardActiveTopRow}>
            <Text style={s.cardActiveRarity}>{catalog.rarity.toUpperCase()}</Text>
            <View style={s.cardActiveBadge}>
              <Text style={s.cardActiveBadgeText}>🛡 {catalog.nft.romanNumeral}</Text>
            </View>
          </View>
          <Text style={s.cardActiveName}>{catalog.name}</Text>
          <View style={s.cardActiveProgressBar}>
            <View style={[s.cardActiveProgressFill, { width: `${progressPct * 100}%` }]} />
          </View>
          <View style={s.cardActiveMetaRow}>
            <Text style={s.cardActiveMeta}>
              {metCount}/{catalog.requirementDays} days
              {cv.daysRemaining !== null ? ` · ${cv.daysRemaining} left` : ''}
            </Text>
            <Text style={s.cardActivePct}>{Math.round(progressPct * 100)}%</Text>
          </View>
          <View style={s.btnViewProgress}>
            <Text style={s.btnViewProgressText}>View Progress →</Text>
          </View>
        </LinearGradient>
      </TouchableOpacity>
    )
  }

  // ─── Claim-pending (completed) ───
  if (status === 'completed') {
    return (
      <TouchableOpacity style={s.cardClaim} onPress={onView} activeOpacity={0.85}>
        <View style={s.cardHead}>
          <Text style={s.statusClaim}>✓ READY TO CLAIM</Text>
          <View style={s.questBadgeDark}>
            <Text style={s.questBadgeDarkText}>🛡 {catalog.nft.romanNumeral}</Text>
          </View>
        </View>
        <Text style={s.questNameClaim}>{catalog.name}</Text>
        <Text style={s.claimReward}>
          Reward: +{catalog.bonusPoints.toLocaleString()} points
        </Text>
        <View style={s.btnClaim}>
          <Text style={s.btnClaimText}>Claim Reward →</Text>
        </View>
      </TouchableOpacity>
    )
  }

  // ─── Claimed (status === 'claimed') ───
  return (
    <View style={[s.cardBase, s.cardDim]}>
      <View style={s.cardBody}>
        <View style={s.cardHead}>
          <View style={{ flex: 1 }}>
            <Text style={s.statusClaimed}>✓ CLAIMED</Text>
            <Text style={s.questName}>{catalog.name}</Text>
            <Text style={s.questEarned}>
              +{(instance.bonusPointsAwarded ?? catalog.bonusPoints).toLocaleString()} points earned
            </Text>
          </View>
          {badgeNeutral}
        </View>
        <TouchableOpacity
          style={[s.btnGhost, starting && s.btnGhostDisabled]}
          onPress={onStart}
          disabled={starting}
          activeOpacity={0.7}
        >
          <Text style={s.btnGhostText}>
            {starting ? 'Starting...' : 'Start Again'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: C.bg },
  scroll:        { flex: 1, paddingHorizontal: 20 },
  scrollContent: { paddingBottom: 32 },

  header:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16 },
  backBtn:   { width: 36, height: 36, borderRadius: 12, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  backArrow: { fontSize: 18, color: C.text, fontWeight: '700' },
  title:     { fontSize: 24, color: C.text, fontWeight: '800', letterSpacing: -0.6 },
  subtitle:  { fontSize: 11, color: C.muted, letterSpacing: 0.5, marginTop: 2 },

  // Connect CTA card (disconnected)
  connectCard:         { backgroundColor: C.amber2, borderRadius: 18, padding: 18, marginBottom: 16, shadowColor: C.amber, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 8 },
  connectMain:         { fontSize: 16, fontWeight: '800', color: C.dark, marginBottom: 14 },
  connectInfoRow:      { flexDirection: 'row', backgroundColor: 'rgba(45,41,38,0.08)', borderRadius: 12, padding: 12, marginBottom: 14, alignItems: 'center' },
  connectInfoCol:      { flex: 1 },
  connectInfoLabel:    { fontSize: 9, color: `${C.dark}99`, letterSpacing: 1.2, fontWeight: '700', marginBottom: 4 },
  connectInfoValue:    { fontSize: 15, fontWeight: '800', color: C.dark },
  connectInfoDivider:  { width: 1, height: 28, backgroundColor: 'rgba(45,41,38,0.18)', marginHorizontal: 12 },
  connectBtn:          { backgroundColor: C.dark, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  connectBtnLoading:   { opacity: 0.7 },
  connectBtnText:      { color: '#fff', fontSize: 14, fontWeight: '800' },

  // Summary strip (connected)
  summary:      { paddingVertical: 4, marginBottom: 12 },
  summaryText:  { fontSize: 12, color: C.sub },
  summaryNum:   { color: C.text, fontWeight: '800' },
  summarySep:   { color: C.muted },

  // Card base
  cardBase:   { flexDirection: 'row', backgroundColor: C.card, borderRadius: 18, borderWidth: 1.5, borderColor: C.line, marginBottom: 12, overflow: 'hidden' },
  cardBody:   { flex: 1, padding: 16 },
  cardHead:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 8 },
  cardDim:    { opacity: 0.72 },

  stripFailed: { width: 4, backgroundColor: C.muted },

  questBadge:        { backgroundColor: C.bg2, borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3 },
  questBadgeText:    { fontSize: 10, color: C.dark2, fontWeight: '700' },
  questBadgeDark:    { backgroundColor: C.dark, borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3 },
  questBadgeDarkText:{ fontSize: 10, color: '#fff', fontWeight: '700' },

  questName:    { fontSize: 17, fontWeight: '800', color: C.text, letterSpacing: -0.3, marginBottom: 2 },
  questTagline: { fontSize: 12, color: C.sub, marginBottom: 8 },
  questReq:     { fontSize: 11, color: C.sub, marginBottom: 4 },
  questReward:  { fontSize: 12, color: C.amber, fontWeight: '700', marginBottom: 14 },

  // Status labels
  statusFailed:  { fontSize: 9, color: C.muted, letterSpacing: 1.2, fontWeight: '800', marginBottom: 4 },
  statusClaimed: { fontSize: 9, color: C.sub, letterSpacing: 1.2, fontWeight: '800', marginBottom: 4 },

  // Active card (gradient)
  cardActiveWrap:           { marginBottom: 12 },
  cardActive:               { borderRadius: 18, padding: 16, overflow: 'hidden' },
  cardActiveTopRow:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardActiveRarity:         { fontSize: 9, color: 'rgba(255,255,255,0.85)', letterSpacing: 1.2, fontWeight: '700' },
  cardActiveBadge:          { backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3 },
  cardActiveBadgeText:      { fontSize: 10, color: '#fff', fontWeight: '700' },
  cardActiveName:           { fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.3, marginBottom: 14 },
  cardActiveProgressBar:    { height: 5, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 100, marginBottom: 8, overflow: 'hidden' },
  cardActiveProgressFill:   { height: 5, backgroundColor: '#fff', borderRadius: 100 },
  cardActiveMetaRow:        { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  cardActiveMeta:           { fontSize: 11, color: 'rgba(255,255,255,0.75)' },
  cardActivePct:            { fontSize: 11, fontWeight: '800', color: '#fff' },
  btnViewProgress:          { backgroundColor: C.dark, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnViewProgressText:      { color: '#fff', fontSize: 14, fontWeight: '800' },

  // Buttons
  btnPrimary:         { backgroundColor: C.amber2, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnPrimaryDisabled: { backgroundColor: C.bg3 },
  btnPrimaryText:     { color: C.dark, fontSize: 14, fontWeight: '800' },
  btnDisabledText:    { color: C.muted },

  btnOutline:         { borderWidth: 1.5, borderColor: C.amber2, backgroundColor: 'transparent', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnOutlineDisabled: { borderColor: C.line, opacity: 0.7 },
  btnOutlineText:     { color: C.amber, fontSize: 14, fontWeight: '800' },

  btnGhost:         { paddingVertical: 10, alignItems: 'center' },
  btnGhostDisabled: { opacity: 0.5 },
  btnGhostText:     { color: C.sub, fontSize: 13, fontWeight: '700' },

  // Claim card
  cardClaim:       { backgroundColor: C.amber2, borderRadius: 18, padding: 18, marginBottom: 12, shadowColor: C.amber, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 8 },
  statusClaim:     { fontSize: 9, color: `${C.dark}99`, letterSpacing: 1.5, fontWeight: '800' },
  questNameClaim:  { fontSize: 18, fontWeight: '900', color: C.dark, letterSpacing: -0.4, marginTop: 4, marginBottom: 2 },
  claimReward:     { fontSize: 12, color: `${C.dark}CC`, fontWeight: '600', marginBottom: 14 },
  btnClaim:        { backgroundColor: C.dark, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnClaimText:    { color: '#fff', fontSize: 14, fontWeight: '800' },

  // Claimed earned text
  questEarned: { fontSize: 12, color: C.amber, fontWeight: '700', marginBottom: 8 },

  // Loading / Empty
  loadingState: { paddingVertical: 40, alignItems: 'center', gap: 10 },
  loadingText:  { fontSize: 12, color: C.muted },
  emptyState:   { paddingVertical: 40, alignItems: 'center' },
  emptyText:    { fontSize: 13, color: C.muted, textAlign: 'center' },
})
