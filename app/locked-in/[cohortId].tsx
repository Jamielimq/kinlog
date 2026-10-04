import type { PublicKey } from '@solana/web3.js'
import { router, useLocalSearchParams } from 'expo-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { OddsSheet } from '../../components/lockedIn/OddsSheet'
import { useWallet } from '../../context/WalletContext'
import { useCohort } from '../../hooks/useCohorts'
import { useLockedIn } from '../../hooks/useLockedIn'
import { type Balances, joinButton, joinErrorAlert, shortOf } from '../../lib/lockedIn/joinButton'
import {
  associatedTokenAddress,
  configPda,
  decodeConfig,
  errorName,
  formatAmount,
  ixDeposit,
  joiningClosesTs,
  SKR_DECIMALS,
  SKR_MINT,
} from '../../lib/lockedIn/program'
import { cohortDayIndex, formatUtc, NBSP } from '../../lib/lockedIn/time'
import { isFull } from '../../lib/lockedIn/visibility'
import { isWalletCancel, sendWithWallet, TxError } from '../../lib/lockedIn/tx'
import { getConnection } from '../../lib/solana'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1',
  card: '#FFFFFF', dark: '#2D2926',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
  green: '#10B981',
}

const DAILY_TARGET = 30

/**
 * SKR (null: no token account) and SOL in one read, plus the minimum balance a wallet must keep
 * (Solana's rent-exempt minimum for an account with no data, read rather than hard-coded because it
 * has changed). Throws if the RPC can't answer, so a failed read is never taken for "no SKR".
 */
async function readBalances(owner: PublicKey): Promise<Balances> {
  const connection = getConnection()
  const [[wallet, skr], rentMin] = await Promise.all([
    connection.getMultipleAccountsInfo([owner, associatedTokenAddress(owner, SKR_MINT)]),
    connection.getMinimumBalanceForRentExemption(0),
  ])
  return {
    skr: skr ? skr.data.readBigUInt64LE(64) : null, // a token account's amount is at byte 64
    lamports: BigInt(wallet?.lamports ?? 0),
    rentMin: BigInt(rentMin),
  }
}

export default function LockedInScreen() {
  const params = useLocalSearchParams<{ cohortId: string }>()
  const key = typeof params.cohortId === 'string' ? params.cohortId : ''
  const { publicKey, connecting, restoring, session, signInError, connect, signIn, dataAddress, authorizeAndSign } = useWallet()
  const { cohort, loading } = useCohort(key)
  const { joined, slot, seats, dayReps, refresh } = useLockedIn(cohort, dataAddress)
  const [now, setNow] = useState(() => Date.now())
  const [showOdds, setShowOdds] = useState(false)
  // 'reading' until the first answer; 'failed' leaves the check to the simulation before the wallet opens.
  const [balances, setBalances] = useState<Balances | 'reading' | 'failed'>('reading')
  // Bumped to read balances again, e.g. after a Join fails.
  const [balanceReads, setBalanceReads] = useState(0)
  const [joining, setJoining] = useState(false)
  const [joinTx, setJoinTx] = useState<string | null>(null)
  // The program said joining has closed; its clock can be ahead of this phone's.
  const [closedOnChain, setClosedOnChain] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Set when Sign in is pressed here, so that a failure shows as an alert, the way a failed Join does.
  const signingInHere = useRef(false)
  useEffect(() => {
    if (!signingInHere.current || session === 'signingIn') return
    signingInHere.current = false
    // A cancel in the wallet leaves no error, and shows nothing.
    if (signInError) Alert.alert("Couldn't sign in", signInError, [{ text: 'OK' }])
  }, [session, signInError])

  const open = !!cohort && !closedOnChain && now / 1000 < joiningClosesTs(cohort)
  // Full only matters while joining is open. The chain's count (read with the slot) is fresher than
  // the server's mirror on the cohort document.
  const full =
    !!cohort && open && (isFull(cohort) || (!!seats && seats.capacity > 0 && seats.participants >= seats.capacity))
  const canJoin = !!cohort && !!publicKey && !!dataAddress && open && !full && slot === null && !joined

  // Balances only matter while joining is possible.
  useEffect(() => {
    if (!canJoin || !publicKey) {
      setBalances('reading')
      return
    }
    let cancelled = false
    readBalances(publicKey).then(
      b => {
        if (!cancelled) setBalances(b)
      },
      (e: any) => {
        console.log('balance read failed:', e?.message ?? e)
        // An earlier answer stays; without one, the simulation is the check.
        if (!cancelled) setBalances(prev => (prev === 'reading' ? 'failed' : prev))
      },
    )
    return () => {
      cancelled = true
    }
  }, [canJoin, publicKey, balanceReads])

  /**
   * After a Join that didn't go through: nothing for a cancel. Otherwise the wallet and the cohort
   * are read again so the button matches what is true now, and the chain decides before anything is
   * called a failure: a wallet found in the cohort just sees the joined screen.
   */
  const afterJoinError = async (e: unknown, deposit: string) => {
    console.log('Join failed:', (e as any)?.message ?? e)
    if (isWalletCancel(e)) return
    setBalanceReads(n => n + 1)
    if (await refresh()) return
    if (e instanceof TxError && e.code !== undefined && errorName(e.code) === 'JoiningClosed') setClosedOnChain(true)
    const { title, body } = joinErrorAlert(e, deposit)
    Alert.alert(title, body, [{ text: 'OK' }])
  }

  const join = async () => {
    if (!publicKey || !cohort) return
    setJoining(true)
    try {
      const connection = getConnection()
      const info = await connection.getAccountInfo(configPda()).catch((e: any) => {
        throw new TxError('network', undefined, [], e?.message ?? String(e))
      })
      const config = info ? decodeConfig(info.data) : null
      if (!config) throw new Error('Locked In config unavailable')
      // A pause needs no check here: the program refuses it in the simulation, before the wallet opens.
      const sig = await sendWithWallet({
        connection,
        payer: publicKey,
        instructions: [ixDeposit(publicKey, cohort.kind, cohort.id, config.feeWallet)],
        authorizeAndSign,
      })
      setJoinTx(sig)
      await refresh()
    } catch (e) {
      await afterJoinError(e, formatAmount(cohort.depositAmount, SKR_DECIMALS))
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
      `${deposit} SKR stays locked until${NBSP}${formatUtc(cohort.endTs)}. After that, you can withdraw it, pass or fail.`,
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

  const button = joinButton({
    joined,
    joining,
    open,
    full,
    connecting: connecting || restoring,
    connected: !!publicKey,
    session,
    slotKnown: slot !== undefined,
    short:
      balances === 'reading' ? undefined
      : balances === 'failed' ? null
      : shortOf(balances, cohort.depositAmount, cohort.feeLamports),
    deposit,
  })
  const onPress =
    button?.action === 'connect' ? () => void connect()
    : button?.action === 'signIn' ? () => {
        signingInHere.current = true
        void signIn()
      }
    : button?.action === 'join' ? confirmJoin
    : undefined

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView style={s.scroll} contentContainerStyle={s.scrollContent} showsVerticalScrollIndicator={false}>
        <Header>
          <Text style={s.eyebrow}>{cohort.isTest ? 'LOCKED IN (TEST)' : 'LOCKED IN'}</Text>
          <Text style={s.title}>{`${cohort.days}-Day Challenge`}</Text>
        </Header>
        {/* Only an ended cohort gets a status line; before that, the terms below say when things happen. */}
        {now / 1000 >= cohort.endTs && <Text style={s.status}>{`Ended${NBSP}${formatUtc(cohort.endTs)}`}</Text>}

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
                ? `Squats count while you are signed in. Day resets at${NBSP}15:00${NBSP}UTC.`
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
          <Term label="Deposit" value={`${deposit} SKR`} note="Returned 100%, pass or fail." strongNote />
          <Term
            label="Goal"
            value={`${DAILY_TARGET} squats a day for ${cohort.days} days`}
            note={realDays ? `Day resets at${NBSP}15:00${NBSP}UTC.` : `Each day is ${Math.round(cohort.daySeconds / 60)} minutes.`}
          />
          <Term label="Starts" value={formatUtc(cohort.startTs)} />
          <Term label="Joining closes" value={formatUtc(joiningClosesTs(cohort))} />
          {cohort.capacity > 0 && <Term label="Joined" value={`${cohort.participants}/${cohort.capacity}`} />}
          <Term label="Ends" value={formatUtc(cohort.endTs)} />
          <Term
            label="Withdraw"
            value={`From${NBSP}${formatUtc(cohort.endTs)}`}
            note={`Returns automatically after${NBSP}${formatUtc(cohort.deadlineTs)}.`}
            last
          />
          <Text style={[s.lockNote, s.emphasis]}>Your SKR stays locked until the challenge ends.</Text>
          <Text style={s.feeNote}>A small fee applies when you join.</Text>
        </View>

        <View style={s.card}>
          <View style={s.cardHead}>
            <Text style={[s.cardTitle, s.flush]}>Reward</Text>
            <TouchableOpacity onPress={() => setShowOdds(true)} activeOpacity={0.7} hitSlop={8}>
              <Text style={s.headLink}>ⓘ Reward odds</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.cardText}>
            Finish every day to pick one Square on a 5×5 board.{' '}
            <Text style={s.emphasis}>Every pick wins at least a Common Square.</Text>
          </Text>
          <Text style={[s.cardText, s.flush]}>
            {`Pick your Square and claim your reward by${NBSP}${formatUtc(cohort.deadlineTs)}. After that, the reward expires.`}
          </Text>
        </View>

        {/* One button for every state (lib/lockedIn/joinButton.ts). A Join that fails says why in an alert. */}
        {button && (
          <View style={s.joinBox}>
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

      <OddsSheet visible={showOdds} onClose={() => setShowOdds(false)} />
    </SafeAreaView>
  )
}

/** Back arrow, with the screen's title beside it as on the Quests screen. */
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

function Term({ label, value, note, strongNote, last }: {
  label: string
  value: string
  note?: string
  strongNote?: boolean
  last?: boolean
}) {
  return (
    <View style={[s.term, !last && s.termBorder]}>
      <Text style={s.termLabel}>{label}</Text>
      <View style={{ flex: 1, alignItems: 'flex-end' }}>
        <Text style={s.termValue}>{value}</Text>
        {note && <Text style={[s.termNote, strongNote && s.emphasis]}>{note}</Text>}
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

  header:    { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  backBtn:   { width: 36, height: 36, borderRadius: 12, backgroundColor: C.card, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  backArrow: { fontSize: 18, color: C.text, fontWeight: '700' },

  eyebrow: { fontSize: 13, color: C.amber, fontWeight: '800', letterSpacing: 1.2 },
  title:   { fontSize: 26, color: C.text, fontWeight: '800', letterSpacing: -0.8, marginTop: 2 },
  status:  { fontSize: 13, color: C.sub, marginTop: 4, marginBottom: 16 },

  card:      { backgroundColor: C.card, borderRadius: 18, padding: 18, marginBottom: 14, borderWidth: 1.5, borderColor: C.line },
  cardHead:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  cardTitle: { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 8 },
  cardText:  { fontSize: 14, color: C.sub, lineHeight: 20, marginBottom: 10 },
  flush:     { marginBottom: 0 },
  note:      { fontSize: 12, color: C.sub, lineHeight: 17, marginTop: 10 },
  link:      { fontSize: 13, color: C.amber, fontWeight: '700', marginTop: 8 },
  headLink:  { fontSize: 13, color: C.amber, fontWeight: '700' },

  term:       { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, gap: 12 },
  termBorder: { borderBottomWidth: 1, borderBottomColor: C.line },
  // Labels never larger than values, notes smaller than values.
  termLabel:  { fontSize: 15, color: C.sub, width: 110 },
  termValue:  { fontSize: 16, color: C.text, fontWeight: '700', textAlign: 'right' },
  termNote:   { fontSize: 13, color: C.muted, marginTop: 2, textAlign: 'right' },
  lockNote:   { fontSize: 13, marginTop: 12 },
  // The screen's three key promises (deposit returned, SKR locked, every pick wins). Color and
  // weight only: no underline or icon, so they don't read as links.
  emphasis:   { color: C.amber, fontWeight: '600' },
  feeNote:    { fontSize: 13, color: C.sub, marginTop: 4 },

  dayRow:      { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.bg2, marginBottom: 6 },
  dayRowToday: { backgroundColor: C.amberBg, borderWidth: 1.5, borderColor: `${C.amber}55` },
  dayLabel:    { fontSize: 13, color: C.text, fontWeight: '600' },
  dayValue:    { fontSize: 13, color: C.text, fontWeight: '800' },

  joinBox: { marginTop: 4 },
  // A fixed height, so every state's button (label or spinner) is the same size as Join.
  btn:         { backgroundColor: C.dark, borderRadius: 14, height: 52, alignItems: 'center', justifyContent: 'center' },
  btnGrey:     { backgroundColor: C.line },
  // 17, as on the how-to and reward odds sheets' buttons.
  btnText:     { color: '#fff', fontSize: 17, fontWeight: '800' },
  btnTextGrey: { color: C.sub },
})
