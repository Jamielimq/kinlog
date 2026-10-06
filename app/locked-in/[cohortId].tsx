import type { PublicKey } from '@solana/web3.js'
import { router, useLocalSearchParams } from 'expo-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { OddsSheet } from '../../components/lockedIn/OddsSheet'
import { Popup, type PopupAction } from '../../components/Popup'
import { useWallet } from '../../context/WalletContext'
import { useCohort } from '../../hooks/useCohorts'
import { useLockedIn } from '../../hooks/useLockedIn'
import { type Balances, joinButton, joinErrorAlert, shortOf } from '../../lib/lockedIn/joinButton'
import {
  associatedTokenAddress,
  configPda,
  decodeConfig,
  errorName,
  FLAG,
  formatAmount,
  hasFlag,
  ixCreateAtaIdempotent,
  ixDeposit,
  ixWithdraw,
  joiningClosesTs,
  ORE_DECIMALS,
  SKR_DECIMALS,
  SKR_MINT,
} from '../../lib/lockedIn/program'
import { COMPLETION_POINTS, joinedButton, TIER_NAME } from '../../lib/lockedIn/reward'
import { cohortDayIndex, formatUtc, NBSP } from '../../lib/lockedIn/time'
import { isFull } from '../../lib/lockedIn/visibility'
import { isWalletCancel, sendWithWallet, TxError } from '../../lib/lockedIn/tx'
import { backInWallet, withdrawButton, withdrawErrorAlert } from '../../lib/lockedIn/withdraw'
import { getConnection } from '../../lib/solana'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1',
  card: '#FFFFFF', dark: '#2D2926',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

const DAILY_TARGET = 30
const OK_ONLY: PopupAction[] = [{ label: 'OK', primary: true }]

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
  const { progress, joined, slot, seats, dayReps, refresh } = useLockedIn(cohort, dataAddress)
  const [now, setNow] = useState(() => Date.now())
  const [showOdds, setShowOdds] = useState(false)
  // 'reading' until the first answer; 'failed' leaves the check to the simulation before the wallet opens.
  const [balances, setBalances] = useState<Balances | 'reading' | 'failed'>('reading')
  // Bumped to read balances again, e.g. after a Join fails.
  const [balanceReads, setBalanceReads] = useState(0)
  const [joining, setJoining] = useState(false)
  const [joinTx, setJoinTx] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState(false)
  const [withdrawTx, setWithdrawTx] = useState<string | null>(null)
  // The program said joining has closed; its clock can be ahead of this phone's.
  const [closedOnChain, setClosedOnChain] = useState(false)
  // The screen's popup: the Join confirm, or a notice after a Join or sign-in. Its content stays
  // while it fades out, so closing only clears popupOpen.
  const [popup, setPopup] = useState<{ title: string; message: string; actions: PopupAction[] } | null>(null)
  const [popupOpen, setPopupOpen] = useState(false)
  const showPopup = (p: { title: string; message: string; actions: PopupAction[] }) => {
    setPopup(p)
    setPopupOpen(true)
  }

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Set when Sign in is pressed here, so that a failure shows in the popup, the way a failed Join does.
  const signingInHere = useRef(false)
  useEffect(() => {
    if (!signingInHere.current || session === 'signingIn') return
    signingInHere.current = false
    // A cancel in the wallet leaves no error, and shows nothing.
    if (signInError) {
      setPopup({ title: "Couldn't sign in", message: signInError, actions: OK_ONLY })
      setPopupOpen(true)
    }
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
    showPopup({ title, message: body, actions: OK_ONLY })
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
    showPopup({
      title: `Join the ${cohort.days}-Day Challenge?`,
      message: `${deposit} SKR stays locked until${NBSP}${formatUtc(cohort.endTs)}. After that, you can withdraw it, pass or${NBSP}fail.`,
      actions: [
        { label: 'Cancel' },
        { label: 'Join', primary: true, onPress: () => void join() },
      ],
    })
  }

  /** After a withdrawal that didn't go through: as after a Join, the chain decides first. */
  const afterWithdrawError = async (e: unknown, opensAt: string) => {
    console.log('Withdraw failed:', (e as any)?.message ?? e)
    if (isWalletCancel(e)) return
    const fresh = await refresh()
    if (fresh && hasFlag(fresh, FLAG.RETURNED)) return
    const { title, body } = withdrawErrorAlert(e, opensAt)
    showPopup({ title, message: body, actions: OK_ONLY })
  }

  /**
   * Takes the deposit back, with no popup first: the wallet's approval screen confirms it. The SKR
   * account is created in the same transaction if the wallet has closed it.
   */
  const withdraw = async () => {
    if (!publicKey || !cohort) return
    setWithdrawing(true)
    try {
      const sig = await sendWithWallet({
        connection: getConnection(),
        payer: publicKey,
        instructions: [ixCreateAtaIdempotent(publicKey, publicKey, SKR_MINT), ixWithdraw(publicKey, cohort.kind, cohort.id)],
        authorizeAndSign,
      })
      setWithdrawTx(sig)
      await refresh()
    } catch (e) {
      await afterWithdrawError(e, formatUtc(cohort.endTs))
    } finally {
      setWithdrawing(false)
    }
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
  const started = now / 1000 >= cohort.startTs
  const ended = now / 1000 >= cohort.endTs
  const beforeDeadline = now / 1000 < cohort.deadlineTs
  const deadline = formatUtc(cohort.deadlineTs)

  // After joining: the chain's slot decides, and the server's record stands in until it has answered.
  const success = slot ? hasFlag(slot, FLAG.SUCCESS) : progress?.success === true
  const picked = slot ? hasFlag(slot, FLAG.PICKED) : typeof progress?.square === 'number'
  const claimed = slot ? hasFlag(slot, FLAG.CLAIMED) : progress?.claimed === true
  const returned = slot ? hasFlag(slot, FLAG.RETURNED) : progress?.returned === true
  const tier = slot ? slot.tier : progress?.tier
  const rewardAmount = slot ? slot.amount : progress?.amount !== undefined ? BigInt(progress.amount) : undefined
  const nextStep = joined ? joinedButton({ success, picked, claimed, beforeDeadline }) : null
  const withdrawBtn = joined ? withdrawButton({ ended, onChain: !!slot, returned, busy: withdrawing, deposit }) : null
  const openSquare = () => router.push(`/locked-in/square/${cohort.key}`)

  const statusTitle = success ? `All ${cohort.days} days done.` : ended ? 'Challenge ended.' : "You're in."
  const statusNote = success
    ? progress?.pointsAwarded ? `You earned ${COMPLETION_POINTS[cohort.kind] ?? 0} points.` : null
    : ended ? null : 'Squats count while you are signed in.'
  // Once received: the result in bold, with the way back to the Square under it.
  const receivedLine = !joined || !claimed ? null
    : tier !== undefined && rewardAmount !== undefined
      ? `${TIER_NAME[tier] ?? 'Reward'}, ${formatAmount(rewardAmount, ORE_DECIMALS)} ORE received`
      : 'Reward received'
  // Once a reward is earned (or can no longer be), one line about it replaces the explanation.
  const rewardLine = !joined || claimed ? null
    : success && !beforeDeadline ? `This reward expired at${NBSP}${deadline}.`
    : success && picked ? `Claim your reward by${NBSP}${deadline}, or it${NBSP}expires.`
    : success ? `Pick a Square by${NBSP}${deadline}, or the reward${NBSP}expires.`
    : ended ? `Not every day reached ${DAILY_TARGET} squats, so there is no Square to${NBSP}pick.`
    : null
  // Days in rows of up to four (a 3-Day challenge in one row).
  const perRow = dayReps.length > 4 ? 4 : Math.max(dayReps.length, 1)
  const dayRows = Array.from({ length: Math.ceil(dayReps.length / perRow) }, (_, r) =>
    dayReps.slice(r * perRow, (r + 1) * perRow).map((reps, k) => ({ reps, i: r * perRow + k })),
  )

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
            <Text style={s.cardTitle}>{statusTitle}</Text>
            {dayRows.map((row, r) => (
              <View key={r} style={s.dayRow}>
                {row.map(({ reps, i }) => {
                  const met = reps >= DAILY_TARGET
                  return (
                    <View key={i} style={[s.day, i === today && s.dayToday]}>
                      <Text style={s.dayLabel}>{`Day ${i + 1}`}</Text>
                      <Text style={[s.dayValue, met && { color: C.amber2 }]}>
                        {`${Math.min(reps, DAILY_TARGET)}/${DAILY_TARGET}${met ? ' ✓' : ''}`}
                      </Text>
                    </View>
                  )
                })}
                {/* Keeps a short last row's cells the same width as the rows above. */}
                {Array.from({ length: perRow - row.length }, (_, k) => <View key={`pad${k}`} style={s.dayPad} />)}
              </View>
            ))}
            {statusNote && <Text style={s.note}>{statusNote}</Text>}
            {/* Without "All done." while a reward is still to pick or receive (lib/lockedIn/withdraw.ts). */}
            {returned && <Text style={s.note}>{`${backInWallet(deposit, success && !claimed)}.`}</Text>}
            {joinTx && (
              <TouchableOpacity onPress={() => Linking.openURL(`https://solscan.io/tx/${joinTx}`)} activeOpacity={0.7}>
                <Text style={s.link}>View deposit on Solscan</Text>
              </TouchableOpacity>
            )}
            {withdrawTx && (
              <TouchableOpacity onPress={() => Linking.openURL(`https://solscan.io/tx/${withdrawTx}`)} activeOpacity={0.7}>
                <Text style={s.link}>View withdrawal on Solscan</Text>
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
          {/* Once in: only what still lies ahead, so the screen keeps to one page. */}
          {!(joined && started) && <Term label="Starts" value={formatUtc(cohort.startTs)} />}
          {!joined && <Term label="Joining closes" value={formatUtc(joiningClosesTs(cohort))} />}
          {!joined && cohort.capacity > 0 && <Term label="Joined" value={`${cohort.participants}/${cohort.capacity}`} />}
          <Term label="Ends" value={formatUtc(cohort.endTs)} />
          {returned ? (
            <Term label="Withdraw" value="Returned" last />
          ) : (
            <Term
              label="Withdraw"
              value={`From${NBSP}${formatUtc(cohort.endTs)}`}
              note={`Returns automatically after${NBSP}${deadline}.`}
              last
            />
          )}
          {!ended && <Text style={[s.lockNote, s.emphasis]}>Your SKR stays locked until the challenge ends.</Text>}
          {!joined && <Text style={s.feeNote}>A small fee applies when you join.</Text>}
        </View>

        <View style={s.card}>
          <View style={s.cardHead}>
            <Text style={[s.cardTitle, s.flush]}>Reward</Text>
            <TouchableOpacity onPress={() => setShowOdds(true)} activeOpacity={0.7} hitSlop={8}>
              <Text style={s.headLink}>ⓘ Reward odds</Text>
            </TouchableOpacity>
          </View>
          {receivedLine ? (
            <>
              <Text style={s.received}>{receivedLine}</Text>
              {/* While the chain has the slot, which the Square screen reads; it goes when the cohort closes. */}
              {slot && (
                <TouchableOpacity style={s.squareLinkBox} onPress={openSquare} activeOpacity={0.7} hitSlop={8}>
                  <Text style={s.squareLink}>{`See your Square${NBSP}›`}</Text>
                </TouchableOpacity>
              )}
            </>
          ) : rewardLine ? (
            <Text style={[s.cardText, s.flush]}>{rewardLine}</Text>
          ) : (
            <>
              <Text style={s.cardText}>
                Finish every day to pick one Square on a 5×5 board.{' '}
                <Text style={s.emphasis}>{`Every pick wins at least a Common${NBSP}Square.`}</Text>
              </Text>
              <Text style={[s.cardText, s.flush]}>
                {`Pick your Square and claim your reward by${NBSP}${deadline}. After that, the reward${NBSP}expires.`}
              </Text>
            </>
          )}
        </View>

        {/* Once in: the way to the Square while a reward is still to pick or receive (lib/lockedIn/reward.ts). */}
        {nextStep && (
          <View style={s.joinBox}>
            <TouchableOpacity style={s.btn} onPress={openSquare} activeOpacity={0.85}>
              <Text style={s.btnText}>{nextStep.label}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* After the end, below the Square's: a reward expires at the deadline, while the deposit is
            returned automatically after it (lib/lockedIn/withdraw.ts). */}
        {withdrawBtn && (
          <View style={[s.joinBox, nextStep && s.joinBoxNext]}>
            <TouchableOpacity
              style={s.btn}
              onPress={withdrawBtn.label ? () => void withdraw() : undefined}
              disabled={!withdrawBtn.label}
              activeOpacity={0.85}
            >
              {withdrawBtn.label ? <Text style={s.btnText}>{withdrawBtn.label}</Text> : <ActivityIndicator color="#fff" />}
            </TouchableOpacity>
          </View>
        )}

        {/* One button for every state (lib/lockedIn/joinButton.ts). A Join that fails says why in the popup. */}
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
  // Once received: the result in bold, and under it a small way back to the Square in the card's grey.
  received:      { fontSize: 15, color: C.text, fontWeight: '800' },
  squareLinkBox: { alignSelf: 'flex-start', marginTop: 6 },
  squareLink:    { fontSize: 13, color: C.sub, fontWeight: '700' },

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

  dayRow:   { flexDirection: 'row', gap: 6, marginBottom: 6 },
  // Every cell has a border (clear unless today), so today's is the same size as the others.
  day:      { flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, backgroundColor: C.bg2, borderWidth: 1.5, borderColor: 'transparent' },
  dayToday: { backgroundColor: C.amberBg, borderColor: `${C.amber}55` },
  dayPad:   { flex: 1 },
  dayLabel: { fontSize: 12, color: C.sub, fontWeight: '600' },
  dayValue: { fontSize: 15, color: C.text, fontWeight: '800', marginTop: 2 },

  joinBox:     { marginTop: 4 },
  joinBoxNext: { marginTop: 10 },
  // A fixed height, so every state's button (label or spinner) is the same size as Join.
  btn:         { backgroundColor: C.dark, borderRadius: 14, height: 52, alignItems: 'center', justifyContent: 'center' },
  btnGrey:     { backgroundColor: C.line },
  // 17, as on the how-to and reward odds sheets' buttons.
  btnText:     { color: '#fff', fontSize: 17, fontWeight: '800' },
  btnTextGrey: { color: C.sub },
})
