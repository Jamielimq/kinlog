import "react-native-get-random-values";
import { Buffer } from "buffer";
global.Buffer = Buffer;

import { Stack } from 'expo-router';
import { WalletProvider } from '../context/WalletContext';

export default function RootLayout() {
  return (
    <WalletProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }}/>
      </Stack>
    </WalletProvider>
  );
}
