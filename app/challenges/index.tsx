import { LinearGradient } from 'expo-linear-gradient'
import { router } from 'expo-router'
import { useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWallet } from '../../context/WalletContext'
import { useChallenges, type ChallengeCatalog, type ChallengeView } from '../../hooks/useChallenges'
import { useStartChallenge } from '../../hooks/useStartChallenge'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926', dark2: '#3A3532', dark3: '#57524E',
  amber: '#D97706', amber2: '#F59E0B', amber3: '#FCD34D', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

// Per-catalog gradient (Phase 2C deep tones). Wrapper retained as the
// single seam for any future rarity-driven override.
function gradientForCatalog(catalog: ChallengeCatalog): [string, string] {
  return [catalog.nft.gradientFrom, catalog.nft.gradientTo]
}

const byReqDays = (a: ChallengeView, b: ChallengeView) =>
  a.catalog.requirementDays - b.catalog.requirementDays

export default function ChallengesScreen() {
  const { publicKey, connecting, connect } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { challenges, instances, loading } = useChallenges(address)
  const { startChallenge } = useStartChallenge()
  const [startingId, setStartingId] = useState<string | null>(null)

  const claimReady = useMemo(
    () => challenges.filter(c => c.effectiveStatus === 'completed').sort(byReqDays),
    [challenges],
  )
  const activeList = useMemo(
    () => challenges.filter(c => c.effectiveStatus === 'active').sort(byReqDays),
    [challenges],
  )
  const completedToday = useMemo(
    () => challenges.filter(c => c.effectiveStatus === 'completed_today').sort(byReqDays),
    [challenges],
  )
  const availableList = useMemo(
    () =>
      challenges
        .filter(c => c.effectiveStatus === 'available' || c.effectiveStatus === 'failed')
        .sort((a, b) => {
          // Failed first (retry-eligible), available after.
          const af = a.effectiveStatus === 'failed' ? 0 : 1
          const bf = b.effectiveStatus === 'failed' ? 0 : 1
          return af !== bf ? af - bf : byReqDays(a, b)
        }),
    [challenges],
  )

  const summary = useMemo(() => {
    const active = challenges.filter(c => c.effectiveStatus === 'active').length
    const completed = instances.filter(i => i.status === 'claimed').length
    const available = challenges.filter(
      c => c.effectiveStatus === 'available' || c.effectiveStatus === 'failed',
    ).length
    return { active, completed, available }
  }, [challenges, instances])

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

  const renderCard = (cv: ChallengeView) => (
    <QuestCard
      key={cv.catalog.id}
      cv={cv}
      walletConnected={!!publicKey}
      starting={startingId === cv.catalog.id}
      onStart={() => handleStart(cv)}
      onView={() => router.push(`/challenges/${cv.catalog.id}`)}
    />
  )

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
              <Text style={s.summaryNum}>{summary.active}</Text> active
              <Text style={s.summarySep}>  ·  </Text>
              <Text style={s.summaryNum}>{summary.completed}</Text> completed
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
          <>
            {claimReady.length > 0 && (
              <>
                <Text style={s.sectionHeader}>CLAIM READY</Text>
                {claimReady.map(renderCard)}
              </>
            )}
            {activeList.length > 0 && (
              <>
                <Text style={s.sectionHeader}>ACTIVE</Text>
                {activeList.map(renderCard)}
              </>
            )}
            {completedToday.length > 0 && (
              <>
                <Text style={s.sectionHeader}>COMPLETED</Text>
                {completedToday.map(renderCard)}
              </>
            )}
            {availableList.length > 0 && (
              <>
                <Text style={s.sectionHeader}>AVAILABLE</Text>
                {availableList.map(renderCard)}
              </>
            )}
          </>
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
  const status = cv.effectiveStatus
  const gradient = gradientForCatalog(catalog)

  const isClaim     = status === 'completed'
  const isActive    = status === 'active'
  const isFailed    = status === 'failed'
  const isCompletedToday = status === 'completed_today'
  const cardPressable = isClaim || isActive
  const startDisabled = !walletConnected || starting

  // Button label + variant (outline reserved for failed retry)
  const btnVariant: 'fill' | 'outline' = isFailed ? 'outline' : 'fill'
  const btnLabel = isClaim
    ? 'Claim Reward →'
    : isActive
    ? 'View Progress →'
    : isFailed
    ? (starting ? 'Starting...' : 'Try Again')
    : starting
    ? 'Starting...'
    : !walletConnected
    ? 'Start Quest'
    : 'Start Quest →'

  const metCount = isActive && instance
    ? Object.values(instance.progress.daysLog ?? {}).filter(d => d.met).length
    : 0

  const inner = (
    <LinearGradient
      colors={gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={s.card}
    >
      <View style={s.cardTopRow}>
        <Text style={s.cardRarity}>{catalog.rarity.toUpperCase()}</Text>
        <View style={s.romanBadge}>
          <Text style={s.romanBadgeText}>🛡 {catalog.nft.romanNumeral}</Text>
        </View>
      </View>

      <Text style={s.cardName}>{catalog.name}</Text>

      {isActive ? (
        <>
          <View style={s.progressBar}>
            <View style={[s.progressFill, { width: `${progressPct * 100}%` }]} />
          </View>
          <View style={s.metaRow}>
            <Text style={s.meta}>
              {metCount}/{catalog.requirementDays} days
              {cv.daysRemaining !== null ? ` · ${cv.daysRemaining} left` : ''}
            </Text>
            <Text style={s.metaPct}>{Math.round(progressPct * 100)}%</Text>
          </View>
        </>
      ) : isClaim ? (
        <Text style={s.cardReward}>
          Reward: +{catalog.bonusPoints.toLocaleString()} points
        </Text>
      ) : isCompletedToday ? (
        <>
          <Text style={s.cardClaimedLabel}>✓ Claimed today</Text>
          <Text style={s.cardClaimedSub}>Available tomorrow</Text>
        </>
      ) : (
        <>
          {isFailed && (
            <Text style={s.cardTagline}>Missed a day · Try again</Text>
          )}
          <Text style={s.cardReq}>
            {catalog.requirementDays} days · {catalog.requirementDailyReps} squats/day
          </Text>
          <Text style={s.cardReward}>
            Reward: +{catalog.bonusPoints.toLocaleString()} points
          </Text>
        </>
      )}

      {isCompletedToday ? null : cardPressable ? (
        <View style={s.btnFill}>
          <Text style={s.btnFillText}>{btnLabel}</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={[
            btnVariant === 'fill' ? s.btnFill : s.btnOutlineWhite,
            startDisabled && (btnVariant === 'fill' ? s.btnFillDisabled : s.btnOutlineWhiteDisabled),
          ]}
          onPress={onStart}
          disabled={startDisabled}
          activeOpacity={0.85}
        >
          <Text
            style={[
              btnVariant === 'fill' ? s.btnFillText : s.btnOutlineWhiteText,
              startDisabled && s.btnDisabledText,
            ]}
          >
            {btnLabel}
          </Text>
        </TouchableOpacity>
      )}
    </LinearGradient>
  )

  if (cardPressable) {
    return (
      <TouchableOpacity style={s.cardWrap} onPress={onView} activeOpacity={0.85}>
        {inner}
      </TouchableOpacity>
    )
  }
  return <View style={s.cardWrap}>{inner}</View>
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
  summary:      { paddingVertical: 4, marginBottom: 4 },
  summaryText:  { fontSize: 12, color: C.sub },
  summaryNum:   { color: C.text, fontWeight: '800' },
  summarySep:   { color: C.muted },

  // Section headers
  sectionHeader: { fontSize: 11, color: C.sub, letterSpacing: 1.4, fontWeight: '800', marginTop: 14, marginBottom: 8, paddingHorizontal: 2 },

  // Unified gradient card
  cardWrap:    { marginBottom: 12 },
  card:        { borderRadius: 18, padding: 16, overflow: 'hidden' },
  cardTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardRarity: { fontSize: 9, color: 'rgba(255,255,255,0.85)', letterSpacing: 1.2, fontWeight: '700' },

  romanBadge:     { backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 100, paddingHorizontal: 8, paddingVertical: 3 },
  romanBadgeText: { fontSize: 10, color: '#fff', fontWeight: '700' },

  cardName:    { fontSize: 17, fontWeight: '800', color: '#fff', letterSpacing: -0.3, marginBottom: 8 },
  cardTagline: { fontSize: 12, color: 'rgba(255,255,255,0.78)', marginBottom: 6 },
  cardReq:     { fontSize: 11, color: 'rgba(255,255,255,0.78)', marginBottom: 4 },
  cardReward:  { fontSize: 12, color: C.amber3, fontWeight: '700', marginBottom: 14 },

  cardClaimedLabel: { fontSize: 13, fontWeight: '800', color: '#fff', marginBottom: 2 },
  cardClaimedSub:   { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 4 },

  progressBar:  { height: 5, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 100, marginBottom: 8, overflow: 'hidden' },
  progressFill: { height: 5, backgroundColor: '#fff', borderRadius: 100 },
  metaRow:      { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 },
  meta:         { fontSize: 11, color: 'rgba(255,255,255,0.75)' },
  metaPct:      { fontSize: 11, fontWeight: '800', color: '#fff' },

  btnFill:         { backgroundColor: C.dark, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnFillDisabled: { opacity: 0.5 },
  btnFillText:     { color: '#fff', fontSize: 14, fontWeight: '800' },

  btnOutlineWhite:         { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)', backgroundColor: 'transparent', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  btnOutlineWhiteDisabled: { borderColor: 'rgba(255,255,255,0.3)' },
  btnOutlineWhiteText:     { color: '#fff', fontSize: 14, fontWeight: '800' },

  btnDisabledText: { opacity: 0.7 },

  // Loading / Empty
  loadingState: { paddingVertical: 40, alignItems: 'center', gap: 10 },
  loadingText:  { fontSize: 12, color: C.muted },
  emptyState:   { paddingVertical: 40, alignItems: 'center' },
  emptyText:    { fontSize: 13, color: C.muted, textAlign: 'center' },
})
