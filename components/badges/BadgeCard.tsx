import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { RARITY_COLOR } from '../../constants/rarity'
import type { BadgeCard as Card } from '../../lib/badgeCards'
import { MonthlyMedal } from '../record/MonthlyMedal'

const C = {
  bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926',
  amber: '#D97706', amber2: '#F59E0B', amberBg: '#FFFBEB',
  text: '#1C1917', muted: '#A8A29E', line: '#E7E5E4',
}

/**
 * One badge on the Badges tab, drawn the same for every kind: its rarity, its emoji (a monthly
 * badge: its medal) with ×N once earned twice or more, then where it stands: Locked; Claim now, with
 * "{n} to claim" when several are open, which claims the oldest; Checking... while a sent claim waits
 * on the chain; or Claimed. Claim now can't be pressed while any claim is under way.
 */
export function BadgeCard({ card, busy, disabled, onClaim }: {
  card: Card
  busy: boolean // its own claim is under way
  disabled: boolean // a claim is under way, its own or another's
  onClaim: () => void
}) {
  const { state } = card
  const lit = state === 'ready' || state === 'checking' || state === 'claimed'
  const pill = lit && card.earned >= 2 && (
    <View style={s.countPill}>
      <Text style={s.countPillText}>×{card.earned}</Text>
    </View>
  )
  const date = card.earnedAt ? ` · ${new Date(card.earnedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}` : ''

  return (
    <View style={[s.card, !lit && s.cardLocked]}>
      <Text style={[s.rarity, { color: RARITY_COLOR[card.rarity] }]}>{card.rarity.toUpperCase()}</Text>
      {card.medal ? (
        <View style={s.medal}>
          <MonthlyMedal badge={card.medal} lit={lit} claimed={state === 'claimed'} />
          {pill}
        </View>
      ) : (
        <View style={[s.emoji, !lit && s.emojiLocked]}>
          <Text style={{ fontSize: 28, opacity: lit ? 1 : 0.4 }}>{card.emoji}</Text>
          {pill}
        </View>
      )}
      <Text style={s.name}>{card.name}</Text>
      <Text style={s.desc}>{card.desc}</Text>

      {/* While loading, an empty tag holds the place, so nothing shows Locked before it is known. */}
      {state === 'loading' && (
        <View style={[s.lockedTag, s.hidden]}>
          <Text style={s.lockedTagText}> </Text>
        </View>
      )}
      {state === 'locked' && (
        <View style={s.lockedTag}>
          <Text style={s.lockedTagText}>🔒 Locked</Text>
        </View>
      )}
      {lit && (
        <View style={s.earnedTag}>
          <Text style={s.earnedTagText}>{card.pts > 0 ? `+${card.pts}pt` : 'Earned'}{date}</Text>
        </View>
      )}
      {state === 'ready' && card.open.length >= 2 && <Text style={s.toClaim}>{`${card.open.length} to claim`}</Text>}
      {(state === 'ready' || (state === 'checking' && busy)) && (
        <TouchableOpacity
          style={[s.claimBtn, busy && s.claimBtnBusy]}
          onPress={onClaim}
          disabled={disabled || state !== 'ready'}
          activeOpacity={0.8}
        >
          <Text style={s.claimText}>{busy ? 'Claiming...' : 'Claim now'}</Text>
        </TouchableOpacity>
      )}
      {state === 'checking' && !busy && (
        <View style={[s.claimBtn, s.claimBtnBusy]}>
          <Text style={s.claimText}>Checking...</Text>
        </View>
      )}
      {state === 'claimed' && (
        <View style={s.claimedTag}>
          <Text style={s.claimedTagText}>✦ Claimed</Text>
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  card:       { width: '47.5%', backgroundColor: C.card, borderRadius: 22, padding: 16, alignItems: 'center', borderWidth: 1.5, borderColor: C.line, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  cardLocked: { backgroundColor: C.bg2, borderColor: C.bg3, opacity: 0.65 },
  rarity:     { fontSize: 8, fontWeight: '800', letterSpacing: 0.8, alignSelf: 'flex-end', marginBottom: 8 },
  emoji:       { width: 60, height: 60, borderRadius: 30, backgroundColor: C.amberBg, borderWidth: 1.5, borderColor: `${C.amber}33`, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  emojiLocked: { backgroundColor: C.bg3, borderColor: C.bg3 },
  // The same box as the emoji's, so monthly cards line up with the rest.
  medal:         { width: 60, height: 60, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  countPill:     { position: 'absolute', top: -6, right: -6, backgroundColor: C.dark, borderRadius: 100, paddingHorizontal: 6, paddingVertical: 2, minWidth: 22, alignItems: 'center', borderWidth: 2, borderColor: C.card },
  countPillText: { fontSize: 10, color: '#fff', fontWeight: '800' },
  name: { fontSize: 13, fontWeight: '800', color: C.text, marginBottom: 4, textAlign: 'center' },
  desc: { fontSize: 10, color: C.muted, textAlign: 'center', lineHeight: 15, marginBottom: 10 },

  earnedTag:     { backgroundColor: C.amberBg, borderWidth: 1, borderColor: `${C.amber}33`, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100, marginBottom: 8 },
  earnedTagText: { fontSize: 10, fontWeight: '700', color: C.amber },
  lockedTag:     { backgroundColor: C.bg3, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  lockedTagText: { fontSize: 10, color: C.muted },
  hidden:        { opacity: 0 },
  // As the old "{n} to claim" under the Earned count.
  toClaim:      { fontSize: 9, color: C.amber, fontWeight: '700', letterSpacing: 0.3 },
  claimBtn:     { marginTop: 8, backgroundColor: C.dark, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100 },
  claimBtnBusy: { backgroundColor: C.muted },
  claimText:    { fontSize: 10, fontWeight: '700', color: C.amber2 },
  claimedTag:     { marginTop: 8, backgroundColor: `${C.amber}22`, borderWidth: 1, borderColor: `${C.amber}44`, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  claimedTagText: { fontSize: 10, fontWeight: '700', color: C.amber2 },
})
