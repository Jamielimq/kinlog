import { getApp } from '@react-native-firebase/app'
import { doc, getFirestore, setDoc } from '@react-native-firebase/firestore'
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js'
import { Connection, PublicKey, SystemProgram, Transaction, clusterApiUrl } from '@solana/web3.js'
import { useState } from 'react'
import { Alert, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useWallet } from '../../context/WalletContext'
import { useBadges } from '../../hooks/useBadges'

const C = {
  bg: '#FAFAF9', bg2: '#F5F4F1', bg3: '#EDECEA',
  card: '#FFFFFF', dark: '#2D2926', dark2: '#3A3532',
  amber: '#D97706', amber2: '#F59E0B', amber3: '#FCD34D', amberBg: '#FFFBEB',
  text: '#1C1917', sub: '#78716C', muted: '#A8A29E', line: '#E7E5E4',
}

const RARITY_COLOR: Record<string, string> = {
  Common: '#78716C', Uncommon: '#0EA5E9', Rare: '#F59E0B', Epic: '#A855F7', Legendary: '#EF4444',
}

const TABS = [
  { key: 'all',     label: 'All'     },
  { key: 'squats',  label: 'Squats'  },
  { key: 'streak',  label: 'Streak'  },
  { key: 'special', label: 'Special' },
]

// Treasury wallet that receives mint fees
const TREASURY_WALLET = new PublicKey('EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ')
const MINT_FEE_LAMPORTS = 1_000_000 // 0.001 SOL

export default function BadgesScreen() {
  const { publicKey, shortAddress, connecting, connect, disconnect, authorizeAndSign } = useWallet()
  const address = publicKey?.toBase58() ?? null
  const { badges, loading } = useBadges(address)
  const [showDisconnect, setShowDisconnect] = useState(false)
  const [activeTab, setActiveTab] = useState('all')
  const [minting, setMinting] = useState<string | null>(null)
  const [mintSuccess, setMintSuccess] = useState<{ badgeName: string; tx: string } | null>(null)

  const filtered = activeTab === 'all' ? badges : badges.filter(b => b.category === activeTab)
  const earned = badges.filter(b => b.earned).length
  const total  = badges.length

  const handleMint = async (badgeId: string) => {
    if (!address || !publicKey) return
    setMinting(badgeId)
    try {
      const connection = new Connection(clusterApiUrl('mainnet-beta'), 'confirmed')
      let txSignature = ''

      await transact(async (wallet) => {
        // Authorize wallet
        const authResult = await wallet.authorize({
          cluster: 'mainnet-beta',
          identity: { name: 'Kinlog', uri: 'https://kinlog.app', icon: '/favicon.ico' },
        })

        // Build transfer transaction
        const { blockhash } = await connection.getLatestBlockhash()
        const tx = new Transaction()
        tx.recentBlockhash = blockhash
        tx.feePayer = publicKey
        tx.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: TREASURY_WALLET,
          lamports: MINT_FEE_LAMPORTS,
        }))

        // Sign and send - pass Transaction object directly (web3js wrapper handles serialization)
        const signatures = await wallet.signAndSendTransactions({
          transactions: [tx],
        })

        console.log('signatures:', JSON.stringify(signatures))
        txSignature = signatures[0]
      })

      // Save mint record to Firebase
      const db = getFirestore(getApp())
      const mintedBadgeData = badges.find(b => b.id === badgeId)
      const mintPts = mintedBadgeData?.pts ?? 0
      const now = Date.now()

      await setDoc(
        doc(db, 'users', address, 'badges', badgeId),
        { mintedAt: now, txSignature },
        { merge: true }
      )

      // Award badge points
      if (mintPts > 0) {
        const { increment: fsIncrement } = await import('@react-native-firebase/firestore')
        await setDoc(doc(db, 'users', address), { points: fsIncrement(mintPts), updatedAt: now }, { merge: true })
        await (await import('@react-native-firebase/firestore')).addDoc(
          (await import('@react-native-firebase/firestore')).collection(db, 'users', address, 'points_history'),
          { reason: `Minted NFT: ${mintedBadgeData?.name}`, amount: mintPts, createdAt: now }
        )
      }

      const mintedBadge = badges.find(b => b.id === badgeId)
      setMintSuccess({ badgeName: mintedBadge?.name ?? badgeId, tx: txSignature })
    } catch (e: any) {
      // Ignore user cancellation
      if (!e?.message?.includes('CancellationException') && !e?.message?.includes('cancelled')) {
        console.error('Mint error:', e)
        Alert.alert('Mint Failed', e?.message ?? 'Transaction failed. Please try again.')
      }
    } finally {
      setMinting(null)
    }
  }

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView style={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.headerSub}>Collection</Text>
            <Text style={s.headerTitle}>My NFT Badges</Text>
          </View>
          {publicKey ? (
            <TouchableOpacity style={s.walletConnected} onPress={() => setShowDisconnect(true)}>
              <View style={s.walletDot}/>
              <Text style={s.walletConnectedText}>{shortAddress}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.walletBtn} onPress={connect} disabled={connecting}>
              <Text style={s.walletBtnText}>{connecting ? 'Connecting...' : 'Connect Wallet'}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Stats row */}
        <View style={s.statsRow}>
          <View style={s.statBox}>
            <Text style={s.statVal}>{earned}</Text>
            <Text style={s.statLbl}>Earned</Text>
          </View>
          <View style={s.statDivider}/>
          <View style={s.statBox}>
            <Text style={s.statVal}>{total - earned}</Text>
            <Text style={s.statLbl}>Locked</Text>
          </View>
          <View style={s.statDivider}/>
          <View style={s.statBox}>
            <Text style={s.statVal}>{total}</Text>
            <Text style={s.statLbl}>Total</Text>
          </View>
        </View>

        {/* Wallet card */}
        <TouchableOpacity style={s.walletCard} onPress={publicKey ? () => setShowDisconnect(true) : connect} activeOpacity={0.8}>
          <View style={[s.walletIndicator, { backgroundColor: publicKey ? C.amber2 : '#EF4444' }]}/>
          <View style={{ flex: 1 }}>
            <Text style={s.walletTitle}>{publicKey ? 'Solana Wallet Connected' : 'Wallet Not Connected'}</Text>
            <Text style={s.walletAddr}>{shortAddress ?? 'Connect to mint NFT badges'}</Text>
          </View>
          <View style={s.walletBadge}>
            <Text style={s.walletBadgeText}>{publicKey ? 'Active' : 'Connect'}</Text>
          </View>
        </TouchableOpacity>

        {/* Category tabs */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabScroll} contentContainerStyle={s.tabRow}>
          {TABS.map(tab => (
            <TouchableOpacity
              key={tab.key}
              style={[s.tab, activeTab === tab.key && s.tabActive]}
              onPress={() => setActiveTab(tab.key)}
              activeOpacity={0.8}
            >
              <Text style={[s.tabText, activeTab === tab.key && s.tabTextActive]}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Badge grid */}
        <View style={s.grid}>
          {filtered.map((b) => (
            <TouchableOpacity key={b.id} style={[s.badgeCard, !b.earned && s.badgeCardLocked]} activeOpacity={0.8}>
              <Text style={[s.rarityLabel, { color: RARITY_COLOR[b.rarity] }]}>
                {b.rarity.toUpperCase()}
              </Text>
              <View style={[s.badgeEmoji, !b.earned && s.badgeEmojiLocked]}>
                <Text style={{ fontSize: 28, opacity: b.earned ? 1 : 0.4 }}>{b.emoji}</Text>
              </View>
              <Text style={s.badgeName}>{b.name}</Text>
              <Text style={s.badgeDesc}>{b.desc}</Text>
              {b.earned ? (
                <View style={s.earnedTag}>
                  <Text style={s.earnedTagText}>
                    +{b.pts}pt{b.earnedAt ? ` · ${new Date(b.earnedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}` : ''}
                  </Text>
                </View>
              ) : (
                <View style={s.lockedTag}>
                  <Text style={s.lockedTagText}>🔒 Locked</Text>
                </View>
              )}
              {b.earned && !b.mintedAt && (
                <TouchableOpacity
                  style={[s.mintBtn, minting === b.id && s.mintBtnDisabled]}
                  onPress={() => handleMint(b.id)}
                  disabled={minting !== null}
                  activeOpacity={0.8}
                >
                  <Text style={s.mintBtnText}>
                    {minting === b.id ? 'Minting...' : 'Mint NFT'}
                  </Text>
                </TouchableOpacity>
              )}
              {b.mintedAt && (
                <View style={s.mintedTag}>
                  <Text style={s.mintedTagText}>✦ Minted</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 24 }}/>
      </ScrollView>

      {/* Mint Success Modal */}
      <Modal visible={!!mintSuccess} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <View style={s.modalHandle}/>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🎉</Text>
            <Text style={s.modalTitle}>NFT Minted!</Text>
            <Text style={[s.modalAddr, { color: C.amber }]}>{mintSuccess?.badgeName}</Text>
            <Text style={s.modalDesc}>Your badge has been successfully recorded on the Solana blockchain.</Text>
            <View style={{ backgroundColor: C.bg2, borderRadius: 12, padding: 12, width: '100%', marginBottom: 20 }}>
              <Text style={{ fontSize: 10, color: C.muted, marginBottom: 4, letterSpacing: 1 }}>TRANSACTION</Text>
              <Text style={{ fontSize: 11, color: C.sub, fontWeight: '600' }} numberOfLines={1}>{mintSuccess?.tx}</Text>
            </View>
            <TouchableOpacity style={s.modalDisconnect} onPress={() => setMintSuccess(null)}>
              <Text style={s.modalDisconnectText}>Awesome! 🚀</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Disconnect Modal */}
      <Modal visible={showDisconnect} transparent animationType="fade">
        <View style={s.modalOverlay}>
          <View style={s.modalBox}>
            <View style={s.modalHandle}/>
            <Text style={s.modalTitle}>Disconnect Wallet?</Text>
            <Text style={s.modalAddr}>{shortAddress}</Text>
            <Text style={s.modalDesc}>Disconnecting your wallet will disable points earning and NFT badge features.</Text>
            <TouchableOpacity style={s.modalDisconnect} onPress={() => { disconnect(); setShowDisconnect(false) }}>
              <Text style={s.modalDisconnectText}>Disconnect</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.modalCancel} onPress={() => setShowDisconnect(false)}>
              <Text style={s.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1, paddingHorizontal: 20 },

  header:              { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 16, paddingBottom: 10 },
  headerSub:           { fontSize: 10, color: C.muted, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  headerTitle:         { fontSize: 22, fontWeight: '800', color: C.text },
  walletBtn:           { backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletBtnText:       { color: '#fff', fontSize: 12, fontWeight: '700' },
  walletConnected:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.dark, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 100 },
  walletDot:           { width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber2 },
  walletConnectedText: { color: '#fff', fontSize: 12, fontWeight: '700' },

  statsRow:    { flexDirection: 'row', backgroundColor: C.card, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1.5, borderColor: C.line, alignItems: 'center' },
  statBox:     { flex: 1, alignItems: 'center' },
  statVal:     { fontSize: 22, fontWeight: '900', color: C.text, marginBottom: 2 },
  statLbl:     { fontSize: 9, color: C.muted, letterSpacing: 0.5, textTransform: 'uppercase' },
  statDivider: { width: 1, height: 32, backgroundColor: C.line },

  walletCard:      { backgroundColor: C.dark, borderRadius: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  walletIndicator: { width: 10, height: 10, borderRadius: 5 },
  walletTitle:     { fontSize: 13, fontWeight: '600', color: '#fff' },
  walletAddr:      { fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 },
  walletBadge:     { backgroundColor: `${C.amber}22`, borderWidth: 1, borderColor: `${C.amber}44`, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 100 },
  walletBadgeText: { fontSize: 11, fontWeight: '700', color: C.amber2 },

  tabScroll:  { marginBottom: 16 },
  tabRow:     { flexDirection: 'row', gap: 8, paddingRight: 20 },
  tab:        { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 100, backgroundColor: C.bg2, borderWidth: 1.5, borderColor: C.line },
  tabActive:  { backgroundColor: C.dark, borderColor: C.dark },
  tabText:    { fontSize: 12, fontWeight: '600', color: C.sub },
  tabTextActive: { color: '#fff' },

  grid:            { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 24 },
  badgeCard:       { width: '47.5%', backgroundColor: C.card, borderRadius: 22, padding: 16, alignItems: 'center', borderWidth: 1.5, borderColor: C.line, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2 },
  badgeCardLocked: { backgroundColor: C.bg2, borderColor: C.bg3, opacity: 0.65 },
  rarityLabel:     { fontSize: 8, fontWeight: '800', letterSpacing: 0.8, alignSelf: 'flex-end', marginBottom: 8 },
  badgeEmoji:      { width: 60, height: 60, borderRadius: 30, backgroundColor: C.amberBg, borderWidth: 1.5, borderColor: `${C.amber}33`, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  badgeEmojiLocked:{ backgroundColor: C.bg3, borderColor: C.bg3 },
  badgeName:       { fontSize: 13, fontWeight: '800', color: C.text, marginBottom: 4, textAlign: 'center' },
  badgeDesc:       { fontSize: 10, color: C.muted, textAlign: 'center', lineHeight: 15, marginBottom: 10 },
  earnedTag:       { backgroundColor: C.amberBg, borderWidth: 1, borderColor: `${C.amber}33`, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100, marginBottom: 8 },
  earnedTagText:   { fontSize: 10, fontWeight: '700', color: C.amber },
  lockedTag:       { backgroundColor: C.bg3, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  lockedTagText:   { fontSize: 10, color: C.muted },
  mintBtn:         { marginTop: 8, backgroundColor: C.dark, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100 },
  mintBtnDisabled: { backgroundColor: C.muted },
  mintBtnText:     { fontSize: 10, fontWeight: '700', color: C.amber2 },
  mintedTag:       { marginTop: 8, backgroundColor: `${C.amber}22`, borderWidth: 1, borderColor: `${C.amber}44`, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 100 },
  mintedTagText:   { fontSize: 10, fontWeight: '700', color: C.amber2 },

  modalOverlay:        { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalBox:            { backgroundColor: C.card, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 28, paddingBottom: 40, alignItems: 'center' },
  modalHandle:         { width: 36, height: 4, backgroundColor: C.line, borderRadius: 100, marginBottom: 24 },
  modalTitle:          { fontSize: 18, fontWeight: '800', color: C.text, marginBottom: 6 },
  modalAddr:           { fontSize: 12, color: C.muted, backgroundColor: C.bg2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 100, marginBottom: 16, fontWeight: '600' },
  modalDesc:           { fontSize: 13, color: C.sub, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  modalDisconnect:     { width: '100%', backgroundColor: C.dark, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  modalDisconnectText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  modalCancel:         { width: '100%', backgroundColor: C.bg2, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  modalCancelText:     { color: C.text, fontSize: 15, fontWeight: '600' },
})
