import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function DisconnectModal({ visible, onCancel, onConfirm }: Props) {
  return (
    <Modal transparent animationType="fade" visible={visible}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <Text style={s.title}>Disconnect Wallet</Text>
          <Text style={s.sub}>Are you sure you want to disconnect?</Text>
          <View style={s.row}>
            <TouchableOpacity style={s.cancelBtn} onPress={onCancel}>
              <Text style={s.cancelT}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.confirmBtn} onPress={onConfirm}>
              <Text style={s.confirmT}>Disconnect</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 32 },
  card: { backgroundColor: '#fff', borderRadius: 20, padding: 24, width: '100%', gap: 12 },
  title: { fontSize: 18, fontWeight: '800', color: '#1A1A1A', textAlign: 'center' },
  sub: { fontSize: 13, color: '#999', textAlign: 'center' },
  row: { flexDirection: 'row', gap: 10, marginTop: 8 },
  cancelBtn: { flex: 1, backgroundColor: '#F4F4F4', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  cancelT: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },
  confirmBtn: { flex: 1, backgroundColor: '#FEE2E2', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  confirmT: { fontSize: 14, fontWeight: '700', color: '#DC2626' },
});