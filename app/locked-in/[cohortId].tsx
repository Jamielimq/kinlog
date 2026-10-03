import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { OddsSheet } from '../../components/lockedIn/OddsSheet'
import { SignInGate } from '../../components/SignInGate'
import { useWallet } from '../../context/WalletContext'
import { type CohortView, useCohort } from '../../hooks/useCohorts'
import { useLockedIn } from '../../hooks/useLockedIn'
import {
  associatedTokenAddress,
  configPda,
  decodeConfig,
  formatAmount,
  ixDeposit,
  joiningClosesTs,
  SKR_DECIMALS,
  SKR_MINT,
} from '../../lib/lockedIn/program'
import { cohortDayIndex, formatUtc } from '../../lib/lockedIn/time'
import { isFull } from '../../lib/lockedIn/visibility'
import { isWalletCancel, sendWithWallet, txErrorMessage } from '../../lib/lockedIn/tx'
import { getConnection } from '../../lib/solana'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1',
  card: '#FFFFFF', dark: '#2D2926', dark3: '#57524E',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
  red: '#B91C1C', green: '#10B981',
}

const DAILY_TARGET = 30
const SOL_DECIMALS = 9
// Base fee (5,000 lamports a signature) plus the priority fee (about 600), with room to spare.
const NETWORK_FEE_MARGIN = 20_000n

/** Lamports as SOL, rounded up to 5 decimals so a requirement never reads low. */
const solCeil = (lamports: bigint) => formatAmount(((lamports + 9_999n) / 10_000n) * 10_000n, SOL_DECIMALS, 5)

function statusLine(c: CohortView, nowMs: number): string {
  const nowSec = nowMs / 1000
  if (nowSec < c.startTs) return `Starts ${formatUtc(c.startTs)}`
  if (nowSec < c.endTs) return `Day ${cohortDayIndex(c.startTs, c.daySeconds, nowMs) + 1} of ${c.days}`
  return `Ended ${formatUtc(c.endTs)}`
}

export default function LockedInScreen() {
  const params = useLocalSearchParams<{ cohortId: string }>()
  const key = typeof params.cohortId === 'string' ? params.cohortId : ''
  const { publicKey, connecting, connect, dataAddress, authorizeAndSign } = useWallet()
  const { cohort, loading } = useCohort(key)
  const { joined, slot, dayReps, refresh } = useLockedIn(cohort, dataAddress)
  const [now, setNow] = useState(() => Date.now())
  const [showOdds, setShowOdds] = useState(false)
  // rentMin: the balance a wallet must keep after the Fee (Solana's rent-exempt minimum for an
  // account with no data), read from the cluster rather than hard-coded because it has changed.
  const [balances, setBalances] = useState<{ skr: bigint | null; lamports: bigint; rentMin: bigint } | null>(null)
  const [joining, setJoining] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joinTx, setJoinTx] = useState<string | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const open = !!cohort && now / 1000 < joiningClosesTs(cohort)
  // Full only matters while joining is open; after that the closed notice says it all.
  const full = !!cohort && open && isFull(cohort)
  const canJoin = !!cohort && !!publicKey && !!dataAddress && open && !full && slot === null && !joined

  // Balances only matter while the Join button is on screen.
  useEffect(() => {
    if (!canJoin || !publicKey) {
      setBalances(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const connection = getConnection()
      let skr: bigint | null = null
      try {
        const b = await connection.getTokenAccountBalance(associatedTokenAddress(publicKey, SKR_MINT))
        skr = BigInt(b.value.amount)
      } catch {
        skr = null // no SKR token account
      }
      try {
        const [lamports, rentMin] = await Promise.all([
          connection.getBalance(publicKey),
          connection.getMinimumBalanceForRentExemption(0),
        ])
        if (!cancelled) setBalances({ skr, lamports: BigInt(lamports), rentMin: BigInt(rentMin) })
      } catch (e: any) {
        console.log('balance read failed:', e?.message ?? e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canJoin, publicKey])

  const join = async () => {
    if (!publicKey || !cohort) return
    setJoining(true)
    setError(null)
    try {
      const connection = getConnection()
      const info = await connection.getAccountInfo(configPda())
      const config = info ? decodeConfig(info.data) : null
      if (!config) throw new Error('Locked In config unavailable')
      if (config.depositsPaused) {
        setError('Joining is paused right now.')
        return
      }
      const sig = await sendWithWallet({
        connection,
        payer: publicKey,
        instructions: [ixDeposit(publicKey, cohort.kind, cohort.id, config.feeWallet)],
        authorizeAndSign,
      })
      setJoinTx(sig)
      await refresh()
    } catch (e: any) {
      console.log('Join failed:', e?.message ?? e)
      if (!isWalletCancel(e)) setError(txErrorMessage(e))
    } finally {
      setJoining(false)
    }
  }

  const confirmJoin = () => {
    if (!cohort) return
    const deposit = formatAmount(cohort.depositAmount, SKR_DECIMALS)
    // The fee amount is left to the wallet's approval screen, which shows it.
    Alert.alert(
      `Join the ${cohort.days}-Day Challenge?`,
      `${deposit} SKR stays locked until ${formatUtc(cohort.endTs)}. After that, you can withdraw it, pass or fail.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Join', onPress: () => void join() },
      ],
    )
  }

  if (loading || !cohort) {
    return (
      <SafeAreaView style={s.safe} edges={['top']}>
        <Header />
        <View style={s.center}>
          {loading ? <ActivityIndicator color={C.amber2} /> : <Text style={s.muted}>{'This challenge is not available.'}</Text>}
        </View>
      </SafeAreaView>
    )
  }

  const deposit = formatAmount(cohort.depositAmount, SKR_DECIMALS)
  const realDays = cohort.daySeconds === 86_400
  const today = cohortDayIndex(cohort.startTs, cohort.daySeconds, now)

  let blocker: string | null = null
  if (balances) {
    const solNeeded = cohort.feeLamports + balances.rentMin + NETWORK_FEE_MARGIN
    if (balances.skr === null) blocker = 'This wallet has no SKR.'
    else if (balances.skr < cohort.depositAmount) blocker = `You need ${deposit} SKR to join.`
    else if (balances.lamports < solNeeded) {
      blocker =
        `Not enough SOL. Joining needs at least ${solCeil(solNeeded)} SOL to cover the fee, network costs, ` +
        'and the minimum balance a Solana wallet must keep.'
    }
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        <Header />

        <Text style={s.eyebrow}>{cohort.isTest ? 'LOCKED IN (TEST)' : 'LOCKED IN'}</Text>
        <Text style={s.title}>{`${cohort.days}-Day Challenge`}</Text>
        <Text style={s.status}>{statusLine(cohort, now)}</Text>

        {/* A full cohort can't be joined, so only the full notice below is shown, not these prompts. */}
        {!(full && !joined) && (!publicKey ? (
          <View style={s.card}>
            <Text style={s.cardText}>Connect your wallet to join.</Text>
            <TouchableOpacity style={s.btn} onPress={connect} disabled={connecting} activeOpacity={0.85}>
              <Text style={s.btnText}>{connecting ? 'Connecting...' : 'Connect Wallet'}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <SignInGate />
        ))}

        {joined && (
          <View style={s.card}>
            <Text style={s.cardTitle}>{"You're in."}</Text>
            {dayReps.map((reps, i) => {
              const met = reps >= DAILY_TARGET
              const isToday = i === today
              return (
                <View key={i} style={[s.dayRow, isToday && s.dayRowToday]}>
                  <Text style={s.dayLabel}>{`Day ${i + 1}${isToday ? ' (today)' : ''}`}</Text>
                  <Text style={[s.dayValue, met && { color: C.green }]}>
                    {`${Math.min(reps, DAILY_TARGET)} / ${DAILY_TARGET}${met ? '  ✓' : ''}`}
                  </Text>
                </View>
              )
            })}
            <Text style={s.note}>
              {realDays
                ? 'Squats count while you are signed in. Day resets at 15:00 UTC.'
                : `Squats count while you are signed in. Each day is ${Math.round(cohort.daySeconds / 60)} minutes.`}
            </Text>
            {joinTx && (
              <TouchableOpacity onPress={() => Linking.openURL(`https://solscan.io/tx/${joinTx}`)} activeOpacity={0.7}>
                <Text style={s.link}>View deposit on Solscan</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={s.card}>
          {/* In time order. The fee amount is not shown here: the wallet's approval screen shows it. */}
          <Term label="Deposit" value={`${deposit} SKR`} note="Returned 100%, pass or fail." />
          <Term
            label="Goal"
            value={`${DAILY_TARGET} squats a day for ${cohort.days} days`}
            note={realDays ? 'Day resets at 15:00 UTC.' : `Each day is ${Math.round(cohort.daySeconds / 60)} minutes.`}
          />
          <Term label="Starts" value={formatUtc(cohort.startTs)} />
          <Term label="Joining closes" value={formatUtc(joiningClosesTs(cohort))} />
          {cohort.capacity > 0 && <Term label="Joined" value={`${cohort.participants}/${cohort.capacity}`} />}
          <Term label="Ends" value={formatUtc(cohort.endTs)} />
          <Term
            label="Withdraw"
            value={`From ${formatUtc(cohort.endTs)}`}
            note={`Returned automatically after ${formatUtc(cohort.deadlineTs)} if not withdrawn.`}
            last
          />
          <Text style={s.lockNote}>Your SKR stays locked until the challenge ends.</Text>
          <Text style={s.feeNote}>A small fee applies when you join.</Text>
        </View>

        <View style={s.card}>
          <Text style={s.cardTitle}>Reward</Text>
          <Text style={s.cardText}>
            Finish every day to pick one Square on a 5×5 board. Every pick wins at least a Common Square.
          </Text>
          <Text style={s.cardText}>
            {`Pick your Square and claim your reward by ${formatUtc(cohort.deadlineTs)}. After that, the reward expires.`}
          </Text>
          <TouchableOpacity onPress={() => setShowOdds(true)} activeOpacity={0.7}>
            <Text style={s.link}>ⓘ Reward odds</Text>
          </TouchableOpacity>
        </View>

        {!joined && !open && <Text style={s.closed}>{`Joining closed on ${formatUtc(joiningClosesTs(cohort))}.`}</Text>}
        {!joined && full && <Text style={s.closed}>This challenge is full.</Text>}

        {canJoin && (
          <View style={s.joinBox}>
            {balances && (
              <Text style={s.balance}>
                {`In this wallet: ${balances.skr === null ? '0' : formatAmount(balances.skr, SKR_DECIMALS, 2)} SKR, ${formatAmount(balances.lamports, SOL_DECIMALS, 4)} SOL`}
              </Text>
            )}
            {blocker && <Text style={s.error}>{blocker}</Text>}
            {error && <Text style={s.error}>{error}</Text>}
            <TouchableOpacity
              style={[s.btn, (joining || !balances || !!blocker) && s.btnDisabled]}
              onPress={confirmJoin}
              disabled={joining || !balances || !!blocker}
              activeOpacity={0.85}
            >
              {joining ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{`Join with ${deposit} SKR`}</Text>}
            </TouchableOpacity>
          </View>
        )}
        {!!dataAddress && open && !full && slot === undefined && !joined && <ActivityIndicator color={C.amber2} style={{ marginTop: 16 }} />}
      </ScrollView>

      <OddsSheet visible={showOdds} onClose={() => setShowOdds(false)} />
    </SafeAreaView>
  )
}

function Header() {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
        <Text style={s.backArrow}>←</Text>
      </TouchableOpacity>
    </View>
  )
}

function Term({ label, value, note, last }: { label: string; value: string; note?: string; last?: boolean }) {
  return (
    <View style={[s.term, !last && s.termBorder]}>
      <Text style={s.termLabel}>{label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <Text style={s.termValue}>{value}</Text>
        {note && <Text style={s.termNote}>{note}</Text>}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  safe:          { flex: 1, backgroundColor: C.bg },
  scroll:        { flex: 1, paddingHorizontal: 20 },
  scrollContent: { paddingBottom: 40 },
  center:        { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted:         { fontSize: 13, color: C.muted },

  header:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  backBtn:   { width: 36, height: 36, borderRadius: 12, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  backArrow: { fontSize: 18, color: C.text, fontWeight: '700' },

  eyebrow: { fontSize: 11, color: C.amber, fontWeight: '800', letterSpacing: 1.2, marginTop: 4 },
  title:   { fontSize: 26, color: C.text, fontWeight: '800', letterSpacing: -0.8, marginTop: 4 },
  status:  { fontSize: 13, color: C.sub, marginTop: 4, marginBottom: 16 },

  card:      { backgroundColor: C.card, borderRadius: 18, padding: 18, marginBottom: 14, borderWidth: 1.5, borderColor: C.line },
  cardTitle: { fontSize: 16, fontWeight: '800', color: C.text, marginBottom: 8 },
  cardText:  { fontSize: 13, color: C.sub, lineHeight: 19, marginBottom: 10 },
  note:      { fontSize: 12, color: C.sub, lineHeight: 17, marginTop: 10 },
  link:      { fontSize: 13, color: C.amber, fontWeight: '700', marginTop: 8 },

  term:       { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, gap: 12 },
  termBorder: { borderBottomWidth: 1, borderBottomColor: C.line },
  termLabel:  { fontSize: 13, color: C.sub, width: 110 },
  termValue:  { fontSize: 14, color: C.text, fontWeight: '700', textAlign: 'right' },
  termNote:   { fontSize: 11, color: C.muted, marginTop: 2, textAlign: 'right' },
  lockNote:   { fontSize: 12, color: C.dark3, marginTop: 12, fontWeight: '600' },
  feeNote:    { fontSize: 12, color: C.sub, marginTop: 4 },

  dayRow:      { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.bg2, marginBottom: 6 },
  dayRowToday: { backgroundColor: C.amberBg, borderWidth: 1.5, borderColor: `${C.amber}55` },
  dayLabel:    { fontSize: 13, color: C.text, fontWeight: '600' },
  dayValue:    { fontSize: 13, color: C.text, fontWeight: '800' },

  closed:  { fontSize: 13, color: C.sub, textAlign: 'center', marginTop: 8 },
  joinBox: { marginTop: 4 },
  balance: { fontSize: 12, color: C.sub, marginBottom: 8, textAlign: 'center' },
  error:   { fontSize: 12, color: C.red, marginBottom: 8, textAlign: 'center' },
  btn:         { backgroundColor: C.dark, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  btnDisabled: { opacity: 0.45 },
  btnText:     { color: '#fff', fontSize: 15, fontWeight: '800' },
})
