import { Redirect } from 'expo-router'

// This version starts no new quests, so there is no quest list: a run still going or waiting for its
// claim shows on Home (app/(tabs)/index.tsx) and opens its own screen (app/challenges/[id].tsx). The
// rest of the quest code goes in the next version.
export default function ChallengesScreen() {
  return <Redirect href="/" />
}
