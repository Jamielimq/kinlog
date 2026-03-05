import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  mode?: 'submit' | 'skip';
}

export default function SubmitModal({ visible, onCancel, onConfirm, mode = 'submit' }: Props) {
  const isSkip = mode === 'skip';
  return (
    <Modal transparent animationType="fade" visible={visible}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <Text style={s.emoji}>{isSkip ? '⚠️' : '🏆'}</Text>
          <Text style={s.title}>{isSkip ? 'Skip Submission?' : 'Submit to Leaderboard?'}</Text>
          <View style={s.infoBox}>
            {isSkip ? (
              <Text style={s.infoLine}>🏅 You got a new best score! Submit it to the leaderboard?</Text>
            ) : (
              <>
                <Text style={s.infoLine}>📋 Your score will be visible on the leaderboard</Text>
                <Text style={s.infoLine}>💸 A small network fee applies</Text>
                <Text style={s.infoLine}>🔒 Unsubmitted scores stay private</Text>
              </>
            )}
          </View>
          <View style={s.row}>
            <TouchableOpacity style={s.cancelBtn} onPress={onCancel}>
              <Text style={s.cancelT}>{isSkip ? 'Skip' : 'Not Now'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.confirmBtn} onPress={onConfirm}>
              <Text style={s.confirmT}>Submit</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 32 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 24, width: '100%', gap: 12, alignItems: 'center' },
  emoji: { fontSize: 40 },
  title: { fontSize: 18, fontWeight: '800', color: '#1A1A1A', textAlign: 'center' },
  infoBox: { backgroundColor: '#F5F0FF', borderRadius: 12, padding: 14, width: '100%', gap: 8 },
  infoLine: { fontSize: 12, color: '#5B21B6', fontWeight: '600' },
  row: { flexDirection: 'row', gap: 10, marginTop: 4, width: '100%' },
  cancelBtn: { flex: 1, backgroundColor: '#F4F4F4', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  cancelT: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },
  confirmBtn: { flex: 1, backgroundColor: '#7C3AED', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  confirmT: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
});