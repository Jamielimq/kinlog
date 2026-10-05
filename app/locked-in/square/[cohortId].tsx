import { router, useLocalSearchParams } from 'expo-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Animated, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { SquareGrid, SquareLegend } from '../../../components/lockedIn/SquareGrid'
import { Popup, type PopupAction } from '../../../components/Popup'
import { useWallet } from '../../../context/WalletContext'
import { useCohort } from '../../../hooks/useCohorts'
import { useLockedIn } from '../../../hooks/useLockedIn'
import { useOreRound } from '../../../hooks/useOreRound'
import { findSettleTx, readRoundResult, type RoundResult, roundPda } from '../../../lib/lockedIn/ore'
import { FLAG, formatAmount, hasFlag, ixClaimReward, ixPickSquare, ORE_DECIMALS, TIER } from '../../../lib/lockedIn/program'
import {
  claimErrorAlert,
  COMPLETION_POINTS,
  pickErrorAlert,
  squareButton,
  TIER_COLOR,
  TIER_LINE,
  TIER_NAME,
  tierReason,
} from '../../../lib/lockedIn/reward'
import { formatUtc, NBSP } from '../../../lib/lockedIn/time'
import { isWalletCancel, sendWithWallet } from '../../../lib/lockedIn/tx'
import { getConnection } from '../../../lib/solana'

const C = {
  bg: '#FAFAF9',
  card: '#FFFFFF', dark: '#2D2926',
  amber: '#D97706', amber2: '#F59E0B',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

const OK_ONLY: PopupAction[] = [{ label: 'OK', primary: true }]
// While a pick waits, the cohort account is read this often as well, in case the server's record
// (which normally prompts the read) is slow to arrive.
const WAITING_REFRESH_MS = 10_000

const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`
const solscanAccount = (address: string) => `https://solscan.io/account/${address}`

/**
 * Pick a Square, wait for its ORE round, reveal the result and receive the reward. Everything is
 * read back from the cohort account, so leaving and coming back restores the screen (Reveal reward
 * is pressed again on each visit until the reward is received).
 */
export default function SquareScreen() {
  const params = useLocalSearchParams<{ cohortId: string }>()
  const key = typeof params.cohortId === 'string' ? params.cohortId : ''
  const { publicKey, dataAddress, authorizeAndSign } = useWallet()
  const { cohort, loading } = useCohort(key)
  const { progress, slot, refresh } = useLockedIn(cohort, dataAddress)
  const [now, setNow] = useState(() => Date.now())
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [revealed, setRevealed] = useState(false)
  // The round's result and Kinlog's settlement transaction (with the result its log records), each
  // kept with the round it is for. A null result: the round can't be read (e.g. ORE has closed it).
  const [result, setResult] = useState<{ round: string; value: RoundResult | null } | null>(null)
  const [settleTx, setSettleTx] = useState<{ round: string; found: { sig: string; result: RoundResult | null } | null } | null>(null)
  const [claimTx, setClaimTx] = useState<string | null>(null)
  const [popup, setPopup] = useState<{ title: string; message: string; actions: PopupAction[] } | null>(null)
  const [popupOpen, setPopupOpen] = useState(false)
  const showPopup = (p: { title: string; message: string; actions: PopupAction[] }) => {
    setPopup(p)
    setPopupOpen(true)
  }
  const appear = useRef(new Animated.Value(0)).current

  const success = !!slot && hasFlag(slot, FLAG.SUCCESS)
  const picked = !!slot && hasFlag(slot, FLAG.PICKED)
  const settled = !!slot && hasFlag(slot, FLAG.SETTLED)
  const claimed = !!slot && hasFlag(slot, FLAG.CLAIMED)
  const waiting = picked && !settled
  const target = picked && slot ? slot.targetRound : null
  const showResult = settled && (revealed || claimed)
  const { resultAt } = useOreRound(waiting ? target : null)

  // A countdown while waiting; otherwise the clock only matters for the deadline.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), waiting ? 1_000 : 30_000)
    return () => clearInterval(t)
  }, [waiting])

  // Read the cohort again while waiting, and while the first read hasn't answered (it may have failed).
  useEffect(() => {
    if (!waiting && slot !== undefined) return
    const t = setInterval(() => void refresh(), WAITING_REFRESH_MS)
    return () => clearInterval(t)
  }, [waiting, slot, refresh])

  // The round's result (for the board) and Kinlog's settlement transaction (for the link), once shown.
  const targetKey = target?.toString()
  const kind = cohort?.kind
  const id = cohort?.id
  const square = slot?.square
  useEffect(() => {
    if (!showResult || !targetKey || kind === undefined || id === undefined || square === undefined) return
    let cancelled = false
    const connection = getConnection()
    const round = BigInt(targetKey)
    readRoundResult(connection, round).then(
      value => {
        if (!cancelled) setResult({ round: targetKey, value })
      },
      (e: any) => {
        console.log('round result read failed:', e?.message ?? e)
        if (!cancelled) setResult({ round: targetKey, value: null })
      },
    )
    findSettleTx(connection, kind, id, round, square).then(
      found => {
        if (!cancelled) setSettleTx({ round: targetKey, found })
      },
      (e: any) => console.log('settlement lookup failed:', e?.message ?? e),
    )
    return () => {
      cancelled = true
    }
  }, [showResult, targetKey, kind, id, square])
  const settlement = settleTx && settleTx.round === targetKey ? settleTx.found : null
  const settleSig = settlement?.sig ?? null
  // The round account first (one quick read); the settlement's own log line once ORE has closed it.
  const roundResult = (result && result.round === targetKey ? result.value : null) ?? settlement?.result ?? null

  useEffect(() => {
    if (showResult) Animated.timing(appear, { toValue: 1, duration: 350, useNativeDriver: true }).start()
  }, [showResult, appear])

  /**
   * After a pick or claim that didn't go through: nothing for a cancel. Otherwise the cohort is read
   * again first, and a wallet whose pick or claim did land just sees the screen move on.
   */
  const afterError = async (e: unknown, done: number, alert: (e: unknown) => { title: string; body: string }) => {
    console.log('Square action failed:', (e as any)?.message ?? e)
    if (isWalletCancel(e)) return
    const fresh = await refresh()
    if (fresh && hasFlag(fresh, done)) return
    const { title, body } = alert(e)
    showPopup({ title, message: body, actions: OK_ONLY })
  }

  const pick = async (square: number) => {
    if (!publicKey || !cohort) return
    setBusy(true)
    try {
      await sendWithWallet({
        connection: getConnection(),
        payer: publicKey,
        instructions: [ixPickSquare(publicKey, cohort.kind, cohort.id, square)],
        authorizeAndSign,
      })
      await refresh()
    } catch (e) {
      await afterError(e, FLAG.PICKED, pickErrorAlert)
    } finally {
      setBusy(false)
    }
  }

  const claim = async () => {
    if (!publicKey || !cohort) return
    setBusy(true)
    try {
      const sig = await sendWithWallet({
        connection: getConnection(),
        payer: publicKey,
        instructions: [ixClaimReward(publicKey, cohort.kind, cohort.id)],
        authorizeAndSign,
      })
      setClaimTx(sig)
      await refresh()
    } catch (e) {
      await afterError(e, FLAG.CLAIMED, claimErrorAlert)
    } finally {
      setBusy(false)
    }
  }

  // A picked Square can't be changed, so the pick is confirmed first; the wallet confirms the rest.
  const confirmPick = () => {
    if (selected === null) return
    const square = selected
    showPopup({
      title: `Pick Square ${square + 1}?`,
      message: "You can't change it after this. Your result comes from the next ORE round.",
      actions: [
        { label: 'Cancel' },
        { label: 'Pick', primary: true, onPress: () => void pick(square) },
      ],
    })
  }

  if (loading || !cohort || !dataAddress || slot === undefined) {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        <Header />
        <View style={s.center}>
          {loading || (cohort && dataAddress) ? (
            <ActivityIndicator color={C.amber2} />
          ) : (
            <Text style={s.muted}>{cohort ? 'Sign in to see your Square.' : 'This challenge is not available.'}</Text>
          )}
        </View>
      </SafeAreaView>
    )
  }

  const beforeDeadline = now / 1000 < cohort.deadlineTs
  const deadline = formatUtc(cohort.deadlineTs)
  const button = squareButton({
    success,
    picked,
    settled,
    claimed,
    beforeDeadline,
    busy,
    selected,
    revealed,
    resultInSec: resultAt === null ? null : Math.max(0, Math.ceil((resultAt - now) / 1000)),
  })
  const onPress =
    button?.action === 'pick' ? confirmPick
    : button?.action === 'reveal' ? () => setRevealed(true)
    : button?.action === 'claim' ? () => void claim()
    : undefined

  // The result in its tier's badge color, with why it is that tier (lib/lockedIn/reward.ts).
  const tier = slot ? slot.tier : TIER.NONE
  const legendary = tier === TIER.LEGENDARY
  const tierColor = TIER_COLOR[tier] ?? C.sub
  const reason = slot && showResult ? tierReason(tier, slot.square, roundResult) : null

  const roundLink = target !== null && (
    <TouchableOpacity
      onPress={() => Linking.openURL(settleSig ? solscanTx(settleSig) : solscanAccount(roundPda(target).toBase58()))}
      activeOpacity={0.7}
    >
      <Text style={s.link}>{`Result from ORE round #${target}`}</Text>
    </TouchableOpacity>
  )

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        <Header>
          <Text style={s.eyebrow}>{cohort.isTest ? 'LOCKED IN (TEST)' : 'LOCKED IN'}</Text>
          <Text style={s.title}>{picked ? 'Your Square' : 'Pick a Square'}</Text>
        </Header>

        <View style={s.card}>
          <SquareGrid
            selected={picked ? null : selected}
            picked={picked && slot ? slot.square : null}
            winning={showResult ? roundResult?.winningSquare ?? null : null}
            motherlode={showResult && legendary}
            onSelect={success && !picked && !busy && beforeDeadline ? setSelected : undefined}
          />
          {showResult && roundResult && <SquareLegend motherlode={legendary} />}
          <Text style={s.powered}>Powered by ORE</Text>
        </View>

        {!slot ? (
          <View style={s.card}>
            <Text style={[s.cardText, s.flush]}>{"You're not in this challenge."}</Text>
          </View>
        ) : !success ? (
          <View style={s.card}>
            <Text style={[s.cardText, s.flush]}>Finish every day to pick one Square.</Text>
          </View>
        ) : !picked ? (
          <View style={s.card}>
            <Text style={s.cardText}>
              Tap a Square, then pick it.{'\n'}
              <Text style={s.emphasis}>Every pick wins at least a Common Square.</Text>
            </Text>
            <Text style={[s.cardText, s.flush]}>
              {`Your result comes from the next ORE round. Pick by${NBSP}${deadline}, or the reward expires.`}
            </Text>
          </View>
        ) : !showResult ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>{settled ? 'Your result is in.' : 'Turning your reps into value'}</Text>
            {roundLink}
          </View>
        ) : (
          <Animated.View
            style={[
              s.card,
              s.resultCard,
              { borderColor: tierColor, backgroundColor: `${tierColor}0D` },
              { opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] },
            ]}
          >
            <View style={s.summaryRow}>
              <Text style={s.summaryText}>{`All ${cohort.days} days done`}</Text>
              {progress?.pointsAwarded && (
                <Text style={s.summaryPoints}>{`+${COMPLETION_POINTS[cohort.kind] ?? 0} points`}</Text>
              )}
            </View>
            <View style={[s.divider, { backgroundColor: `${tierColor}33` }]} />
            <View style={s.tierRow}>
              <Text style={[s.tierName, { color: tierColor }]}>{TIER_NAME[slot.tier] ?? 'Square'}</Text>
              <Text style={[s.amount, { color: tierColor }]}>{`${formatAmount(slot.amount, ORE_DECIMALS)} ORE`}</Text>
            </View>
            <Text style={s.tierLine}>{TIER_LINE[slot.tier] ?? ''}</Text>
            {reason && <Text style={s.reason}>{reason}</Text>}
            {claimed && <Text style={s.received}>Received to your wallet.</Text>}
            <View style={s.resultLink}>{roundLink}</View>
            {claimTx && (
              <TouchableOpacity onPress={() => Linking.openURL(solscanTx(claimTx))} activeOpacity={0.7}>
                <Text style={s.link}>View the transfer on Solscan</Text>
              </TouchableOpacity>
            )}
          </Animated.View>
        )}

        {button && (
          <View style={s.btnBox}>
            <TouchableOpacity style={[s.btn, button.grey && s.btnGrey]} onPress={onPress} disabled={!onPress} activeOpacity={0.85}>
              {button.label ? (
                <Text style={[s.btnText, button.grey && s.btnTextGrey]}>{button.label}</Text>
              ) : (
                <ActivityIndicator color={button.grey ? C.muted : '#fff'} />
              )}
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {popup && (
        <Popup
          visible={popupOpen}
          title={popup.title}
          message={popup.message}
          actions={popup.actions}
          onClose={() => setPopupOpen(false)}
        />
      )}
    </SafeAreaView>
  )
}

/** Back arrow, with the screen's title beside it as on the challenge screen. */
function Header({ children }: { children?: ReactNode }) {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
        <Text style={s.backArrow}>←</Text>
      </TouchableOpacity>
      {children && <View style={{ flex: 1 }}>{children}</View>}
    </View>
  )
}

const s = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: C.bg },
  scroll:        { flex: 1, paddingHorizontal: 20 },
  scrollContent: { paddingBottom: 40 },
  center:        { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted:         { fontSize: 13, color: C.muted },

  header:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  backBtn:   { width: 36, height: 36, borderRadius: 12, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  backArrow: { fontSize: 18, color: C.text, fontWeight: '700' },

  eyebrow: { fontSize: 13, color: C.amber, fontWeight: '800', letterSpacing: 1.2 },
  title:   { fontSize: 26, color: C.text, fontWeight: '800', letterSpacing: -0.8, marginTop: 2 },

  card:      { backgroundColor: C.card, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1.5, borderColor: C.line },
  cardTitle: { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 8 },
  cardText:  { fontSize: 14, color: C.sub, lineHeight: 20, marginBottom: 10 },
  flush:     { marginBottom: 0 },
  emphasis:  { color: C.amber, fontWeight: '600' },
  powered:   { fontSize: 12, color: C.muted, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  link:      { fontSize: 13, color: C.amber, fontWeight: '700', marginTop: 4 },

  // The result card takes its tier's color for the border, a light tint, the tier name and the amount.
  resultCard:    { borderWidth: 2 },
  // The two sizes share a baseline.
  summaryRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  summaryText:   { fontSize: 20, color: C.text, fontWeight: '800' },
  summaryPoints: { fontSize: 16, color: C.text, fontWeight: '800' },
  divider:       { height: 1, marginVertical: 12 },
  tierRow:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 },
  tierName:      { fontSize: 24, fontWeight: '800', flexShrink: 1 },
  amount:        { fontSize: 18, fontWeight: '800' },
  tierLine:      { fontSize: 15, color: C.sub, marginTop: 4 },
  reason:        { fontSize: 14, color: C.text, fontWeight: '600', lineHeight: 20, marginTop: 6 },
  received:      { fontSize: 13, color: C.sub, marginTop: 8 },
  resultLink:    { marginTop: 6 },

  btnBox: { marginTop: 4 },
  // The challenge screen's button: fixed height, so a label or a spinner is the same size.
  btn:         { backgroundColor: C.dark, borderRadius: 14, height: 52, alignItems: 'center', justifyContent: 'center' },
  btnGrey:     { backgroundColor: C.line },
  btnText:     { color: '#fff', fontSize: 17, fontWeight: '800' },
  btnTextGrey: { color: C.sub },
})
