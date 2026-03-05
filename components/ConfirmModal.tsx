import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onCancel: () => void;
  onConfirm: () => void;
  destructive?: boolean;
}

export default function ConfirmModal({ visible, title, message, confirmText = 'Confirm', cancelText = 'Cancel', onCancel, onConfirm, destructive = false }: Props) {
  return (
    <Modal transparent animationType="fade" visible={visible}>
      <View style={s.backdrop}>
        <View style={s.card}>
          <Text style={s.title}>{title}</Text>
          <Text style={s.message}>{message}</Text>
          <View style={s.row}>
            <TouchableOpacity style={s.cancelBtn} onPress={onCancel}>
              <Text style={s.cancelT}>{cancelText}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.confirmBtn, destructive && s.destructiveBtn]} onPress={onConfirm}>
              <Text style={s.confirmT}>{confirmText}</Text>
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
  message: { fontSize: 13, color: '#666', textAlign: 'center' },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  cancelBtn: { flex: 1, backgroundColor: '#F4F4F4', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  cancelT: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },
  confirmBtn: { flex: 1, backgroundColor: '#7C3AED', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  destructiveBtn: { backgroundColor: '#C4A882' },
  confirmT: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },
});