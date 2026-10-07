import { useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Popup, type PopupAction } from '../../components/Popup'
import { MonthCalendar } from '../../components/record/MonthCalendar'
import { MonthlyBadgeGrid, type MonthlyBadgeItem, type MonthlyBadgeState } from '../../components/record/MonthlyBadgeGrid'
import { SignInGate } from '../../components/SignInGate'
import { useWallet } from '../../context/WalletContext'
import { useMonthlyBadges } from '../../hooks/useMonthlyBadges'
import { useWorkoutDays } from '../../hooks/useWorkoutDays'
import { badgeClaimAlert, claimInstructions } from '../../lib/badgeClaim'
import { isWalletCancel, sendWithWallet, TxError } from '../../lib/lockedIn/tx'
import type { PendingClaim } from '../../lib/pendingClaims'
import {
  addMonths,
  claimMemo,
  goalDays,
  monthlyBadgeId,
  MONTHLY_BADGES,
  monthlyReached,
  monthOf,
  monthRange,
  monthsBetween,
  streakStats,
} from '../../lib/record'
import { getConnection } from '../../lib/solana'

const C = {
  bg: '#FAFAF9',
  amber: '#D97706', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E',
}

const OK_ONLY: PopupAction[] = [{ label: 'OK', primary: true }]

/**
 * The record: a month calendar and that month's badges with the current streak, all counted from the
 * workouts on the device's calendar, where a day counts once it reaches the daily goal
 * (lib/record.ts). A tap on an unlocked badge claims it for 0.001 SOL straight away, as the Badges
 * tab's Claim now does (lib/badgeClaim.ts); the wallet's approval screen is the confirmation. The
 * claim's signature is kept on the phone from the moment the wallet sends it
 * (hooks/useMonthlyBadges.ts), so a payment that went through is recorded even if this screen
 * couldn't finish.
 */
export default function GoalsScreen() {
  const { publicKey, dataAddress, authorizeAndSign } = useWallet()
  const { totals, today, loading: workoutsLoading } = useWorkoutDays(dataAddress)
  const days = goalDays(totals)
  const { records, sent, recheck, trackSent, settleSent, dropSent } = useMonthlyBadges(dataAddress, days, today)
  // Months back from this one, so the view follows the calendar into a new month.
  const [back, setBack] = useState(0)
  const [claiming, setClaiming] = useState<string | null>(null)
  // Set on the tap itself: state only changes on the next render, which a fast second tap can beat.
  const claimingRef = useRef(false)

  // Coming back to Goals looks at claims sent earlier again (the tab stays mounted).
  useFocusEffect(
    useCallback(() => {
      void recheck()
    }, [recheck]),
  )
  // The popup's content stays while it fades out, so closing only clears popupOpen.
  const [popup, setPopup] = useState<{ title: string; message: string; actions: PopupAction[] } | null>(null)
  const [popupOpen, setPopupOpen] = useState(false)
  const showPopup = (p: { title: string; message: string; actions: PopupAction[] }) => {
    setPopup(p)
    setPopupOpen(true)
  }

  const { first, last } = monthRange(totals, today)
  const span = monthsBetween(first, last)
  const steps = Math.min(back, span)
  const month = addMonths(last, -steps)

  // Nothing can be claimed, and no badge shows Locked or Claim, until the workouts, the records and
  // the claims kept on the phone are all read.
  const loading = !!dataAddress && (workoutsLoading || records === null || sent === null)
  // The home screen's STREAK (hooks/useUserStats.ts uses the same count), beside this month's badges
  // only, and not at all while reading or at 0, so no 0 flashes.
  const current = streakStats(days, today).current
  const streak = !loading && month === monthOf(today) && current > 0 ? current : undefined
  const reached = monthlyReached(days, month, today)
  const items: MonthlyBadgeItem[] = MONTHLY_BADGES.map(badge => {
    const id = monthlyBadgeId(badge.type, month)
    const record = records?.get(id)
    const sentState = sent?.get(id)
    const state: MonthlyBadgeState =
      loading ? 'loading'
      : record?.claimed || sentState === 'unsaved' ? 'claimed'
      : sentState === 'checking' ? 'checking'
      : reached.has(badge.type) || record?.earned ? 'unlocked'
      : 'locked'
    return { badge, state, busy: claiming === id }
  })

  const claim = async (item: MonthlyBadgeItem) => {
    const { badge } = item
    const id = monthlyBadgeId(badge.type, month)
    if (claimingRef.current || loading || !publicKey || !dataAddress || !records || !sent) return
    if (records.get(id)?.claimed || sent.has(id)) return
    claimingRef.current = true
    setClaiming(id)
    const memo = claimMemo(badge.type, month)
    // Set by onSent: from then on the payment may go through whatever happens here.
    const kept: { claim: PendingClaim | null } = { claim: null }
    try {
      await sendWithWallet({
        connection: getConnection(),
        payer: publicKey,
        instructions: claimInstructions(publicKey, memo),
        authorizeAndSign,
        onSent: async (signature, lastValidBlockHeight) => {
          kept.claim = { id, type: badge.type, month, memo, signature, lastValidBlockHeight, sentAt: Date.now() }
          await trackSent(kept.claim)
        },
      })
      // Confirmed. The tile turns to Claimed; only a claim that couldn't be saved yet is told.
      if (kept.claim && !(await settleSent(kept.claim))) {
        showPopup({
          title: 'Claim not saved yet',
          message: "Your claim went through, but it couldn't be saved yet. The badge shows as claimed while Kinlog keeps trying to save it.",
          actions: OK_ONLY,
        })
      }
    } catch (e) {
      console.log('Badge claim failed:', (e as any)?.message ?? e)
      if (!isWalletCancel(e)) {
        let alert = badgeClaimAlert(e)
        if (kept.claim) {
          // Sent. Only a failure the chain reported is final: nothing was paid, so it can be claimed
          // again. Anything else (expired, a wallet or network error) stays Checking, for recheck to
          // settle by searching the whole history.
          if (e instanceof TxError && e.kind === 'failed') {
            await dropSent(kept.claim)
          } else {
            alert = {
              title: 'Not confirmed yet',
              body: "Your claim was sent but isn't confirmed yet. Until Kinlog confirms it, the badge shows Checking. If it doesn't go through, you can claim it again.",
            }
          }
        }
        showPopup({ title: alert.title, message: alert.body, actions: OK_ONLY })
      }
    } finally {
      claimingRef.current = false
      setClaiming(null)
    }
  }

  return (
    // Top edge only: the tab bar already covers the bottom inset (see app/(tabs)/index.tsx).
    <SafeAreaView style={s.safe} edges={['top']}>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <View style={s.header}>
          <Text style={s.headerSub}>Tracking</Text>
          <Text style={s.headerTitle}>Goal Tracker</Text>
        </View>

        {!publicKey && (
          <View style={s.noWallet}>
            <Text style={s.noWalletText}>Connect your wallet to track goals</Text>
          </View>
        )}
        <SignInGate />

        <MonthCalendar
          month={month}
          totals={totals}
          today={today}
          onPrev={steps < span ? () => setBack(steps + 1) : undefined}
          onNext={steps > 0 ? () => setBack(steps - 1) : undefined}
        />
        <MonthlyBadgeGrid month={month} items={items} streak={streak} onClaim={item => void claim(item)} />
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

const s = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: C.bg },
  scroll:  { flex: 1, paddingHorizontal: 20 },
  content: { paddingBottom: 8 },

  header:      { paddingTop: 16, paddingBottom: 16 },
  headerSub:   { fontSize: 10, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  headerTitle: { fontSize: 22, fontWeight: '800', color: C.text },

  noWallet:     { backgroundColor: C.amberBg, borderRadius: 14, padding: 16, marginBottom: 16, alignItems: 'center' },
  noWalletText: { fontSize: 13, color: C.amber, fontWeight: '600' },
})
