import { Tabs } from 'expo-router';
import { Text } from 'react-native';

function TabIcon({ symbol, color }: { symbol: string; color: string }) {
  return <Text style={{ fontSize: 20, color }}>{symbol}</Text>;
}

export default function TabLayout() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: '#F59E0B',
      tabBarInactiveTintColor: '#A8A29E',
      tabBarStyle: {
        backgroundColor: '#FFFFFF',
        borderTopColor: '#E8E6E3',
        height: 84,
        paddingBottom: 24,
        paddingTop: 8,
      },
    }}>
      <Tabs.Screen name="index"   options={{ title: 'Home',    tabBarIcon: ({ color }) => <TabIcon symbol="⌂" color={color} /> }}/>
      <Tabs.Screen name="workout" options={{ title: 'Workout', tabBarIcon: ({ color }) => <TabIcon symbol="◉" color={color} /> }}/>
      <Tabs.Screen name="badges"  options={{ title: 'Badges',  tabBarIcon: ({ color }) => <TabIcon symbol="✦" color={color} /> }}/>
      <Tabs.Screen name="goals"   options={{ title: 'Goals',   tabBarIcon: ({ color }) => <TabIcon symbol="◎" color={color} /> }}/>
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: ({ color }) => <TabIcon symbol="◐" color={color} /> }}/>
    </Tabs>
  );
}
