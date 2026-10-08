import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { MonthCalendar } from '../../components/record/MonthCalendar'
import { MonthlyBadgeGrid, type MonthlyBadgeItem, type MonthlyBadgeState } from '../../components/record/MonthlyBadgeGrid'
import { SignInGate } from '../../components/SignInGate'
import { useClaims } from '../../context/ClaimsContext'
import { useWallet } from '../../context/WalletContext'
import { monthlyClaim } from '../../lib/claims'
import {
  addMonths,
  monthlyBadgeId,
  MONTHLY_BADGES,
  monthlyReached,
  monthOf,
  monthRange,
  monthsBetween,
  streakStats,
} from '../../lib/record'

const C = {
  bg: '#FAFAF9',
  amber: '#D97706', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E',
}

/**
 * The record: a month calendar and that month's badges with the current streak, all counted from the
 * workouts on the device's calendar, where a day counts once it reaches the daily goal
 * (lib/record.ts). A tap on an unlocked badge claims it for 0.001 SOL straight away, through the
 * same flow as the Badges tab (context/ClaimsContext.tsx); the wallet's approval screen is the
 * confirmation. A claim that goes through only changes the badge; one that doesn't gets a popup.
 */
export default function GoalsScreen() {
  const { publicKey } = useWallet()
  const { totals, today, days, monthly, sent, loading, claimingId, claim, recheck } = useClaims()
  // Months back from this one, so the view follows the calendar into a new month.
  const [back, setBack] = useState(0)

  // Coming back to Goals looks at claims sent earlier again (the tab stays mounted).
  useFocusEffect(
    useCallback(() => {
      void recheck()
    }, [recheck]),
  )

  const { first, last } = monthRange(totals, today)
  const span = monthsBetween(first, last)
  const steps = Math.min(back, span)
  const month = addMonths(last, -steps)

  // The home screen's STREAK (hooks/useUserStats.ts uses the same count), beside this month's badges
  // only, and not at all while reading or at 0, so no 0 flashes.
  const current = streakStats(days, today).current
  const streak = !loading && month === monthOf(today) && current > 0 ? current : undefined
  const reached = monthlyReached(days, month, today)
  const items: MonthlyBadgeItem[] = MONTHLY_BADGES.map(badge => {
    const id = monthlyBadgeId(badge.type, month)
    const record = monthly?.get(id)
    const sentState = sent?.get(id)
    const state: MonthlyBadgeState =
      loading ? 'loading'
      : record?.claimed || sentState === 'unsaved' || sentState === 'saved' ? 'claimed'
      : sentState === 'checking' ? 'checking'
      : reached.has(badge.type) || record?.earned ? 'unlocked'
      : 'locked'
    return { badge, state, busy: claimingId === id }
  })

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
        <MonthlyBadgeGrid
          month={month}
          items={items}
          streak={streak}
          claiming={claimingId !== null}
          onClaim={item => void claim(monthlyClaim(item.badge, month))}
        />
      </ScrollView>
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
