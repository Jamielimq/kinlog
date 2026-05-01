# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kinlog — Expo (bare workflow) React Native fitness dApp targeting **Android / Solana Seeker**. AI-powered squat counting via on-device MediaPipe; achievements stored in Firestore and "minted" by paying SOL on Solana Mainnet. iOS is configured but not the primary target (the pose detector is Android-only).

Tagline: **"Move · Earn · Evolve"**. Built for the MONOLITH Solana Mobile Hackathon 2026, connected to RadiantsDAO. **Currently live on the Solana dApp Store**, Lifestyle category, version 1.1.0 (`versionCode 4`) — bumping these in `android/app/build.gradle` is a release-affecting change.

## Commands

```bash
npm run start        # expo start (Metro)
npm run android      # expo run:android — required for the native PoseLandmarker module
npm run lint         # expo lint
```

There is no test runner configured. The `web` script exists but the app depends on a native Android module and the camera, so web/iOS will not be functional.

Release builds need `KINLOG_UPLOAD_STORE_FILE` / `_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` set in `~/.gradle/gradle.properties` (see `android/app/build.gradle`).

## Build Environment

- **Always export Java 17 before any Android build** — Gradle here will not work on a different JDK:
  ```bash
  export JAVA_HOME=$(/usr/libexec/java_home -v 17)
  ```
- **DO NOT run `./gradlew clean`.** It wipes codegen output for `react-native-gesture-handler`, `react-native-reanimated`, and `react-native-worklets`, and the project will not rebuild cleanly afterward. If you need a fresh release build, delete only the APK and re-run Expo:
  ```bash
  rm android/app/build/outputs/apk/release/app-release.apk
  npx expo run:android --variant release --device
  ```
- Release APK output: `android/app/build/outputs/apk/release/app-release.apk` (absolute: `~/kinlog/android/app/build/outputs/apk/release/app-release.apk`).

## Architecture

### Routing & shell
- `expo-router` v6, file-based, `typedRoutes` + `reactCompiler` experiments enabled, `newArchEnabled: true`.
- `app/_layout.tsx` wraps everything in `WalletProvider`. All tabs assume `useWallet()` is available.
- 5 tabs in `app/(tabs)/`: `index`, `workout`, `badges`, `goals`, `profile`.

### Wallet layer (`context/WalletContext.tsx`)
- Uses `@solana-mobile/mobile-wallet-adapter-protocol-web3js` `transact()` against **mainnet-beta**.
- The address is loaded from `authResult.accounts[0].address` as base64 → `PublicKey`. The base58 string is the Firestore user document ID throughout the app — never use a different identifier.
- `authorizeAndSign()` reuses an `auth_token` stored in a ref to avoid re-prompting on every signed action; if the cached token is gone it falls back to `wallet.authorize()`.
- On connect, `initUserInFirestore()` not only creates the user doc but **re-derives** `points`, `totalSquats`, `totalWorkouts`, and `bestStreak` from the `points_history` and `workouts` subcollections. **Subcollections are the source of truth**; the parent `users/{addr}` doc is a denormalized cache. Keep this invariant when adding writes.

### Pose detection (the core feature)
- Native Kotlin module `PoseLandmarker` lives in `android/app/src/main/java/com/kinlog/app/` and is registered through `PoseLandmarkerPackage` in `MainApplication.kt`. The MediaPipe model file is `android/app/src/main/assets/pose_landmarker_lite.task`.
- The module exposes `initialize / detectPose(filePath) / release`. It runs in `RunningMode.IMAGE` and returns only the 6 leg landmarks (hip/knee/ankle, indices 23–28).
- JS bridge: `hooks/usePoseLandmarker.ts` (initialize on mount, release on unmount, plus a pure `calcAngle` helper).
- Workout loop in `app/(tabs)/workout.tsx`: every 100 ms, take a `react-native-vision-camera` snapshot at quality 30, write to a temp file, pass the path to `detectPose`. The `useFrameProcessor` defined there is a no-op — detection happens via snapshots, **not** the frame processor. A `detectingRef` guard prevents overlapping detections.
- Squat state machine: `up → down` when knee angle `< 110°`; `down → up` when angle `> 150°` (side) or `> 160°` (front). One transition cycle = 1 rep. Side mode picks the leg with higher landmark visibility; front mode averages both legs. These thresholds are intentional (clinical PT calibration per README) — coordinate before changing them.

### Firestore data model
All paths are under `users/{walletBase58}`:
- Parent doc: `points`, `totalSquats`, `totalWorkouts`, `currentStreak`, `bestStreak`, `dailyReps`, `lastWorkoutDate` (all denormalized — see invariant above).
- `workouts/{auto}` — `{ exercise, reps, elapsed, createdAt }`. Source of truth for squat totals.
- `points_history/{auto}` — `{ reason, amount, createdAt }`. Source of truth for points.
- `badges/{badgeId}` — `{ earned, earnedAt, mintedAt?, nftMint? }`. The catalog itself (`ALL_BADGES`) is hardcoded in `hooks/useBadges.ts`.
- `goals/{daily|weekly|monthly}` — `{ current, total, lastResetDate }`. Reset on read in `useGoals` if `lastResetDate` is older than the current day/week/month boundary. **Week starts Monday** (`(getDay() + 6) % 7`).
- `cache/skr_staking` — cached SKR stake account address.

### Workout write path (`workout.tsx::saveWorkout`)
This function bundles a lot of game logic; read it before changing related code.
- Daily idempotency: caps `effectiveReps` at `TARGET (30) − dailyReps`, so re-running won't double-count.
- Streak: same-day = unchanged; ≤24 h since last = +1; otherwise reset to 1.
- Increments `points` via Firestore `increment(pts)` with `POINTS_PER_REP = 5`.
- Calls `checkAndAwardBadges()`, which parses thresholds out of badge IDs (e.g., `squats_300` → 300, `streak_7` → 7). Adding a new threshold-style badge is just adding to `ALL_BADGES` with the right ID format.

### Badge "minting"
`app/(tabs)/badges.tsx::handleMint` is currently a SOL transfer to a hardcoded treasury wallet (`EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ`, 0.001 SOL = `MINT_FEE_LAMPORTS`). On a successful signature it sets `mintedAt` / `nftMint` on the badge doc. There is no actual NFT mint instruction yet — the metadata in `BadgeNFTMetadata` is forward-looking.

### SKR staking detection (`hooks/useSkrStaking.ts`)
Detects whether the user has ≥1 SKR staked, which auto-awards the `skr_staker` badge. Three-tier lookup: Firestore cache → Helius transaction history → `getProgramAccounts`. Reads raw account bytes at fixed offsets (`offset: 41` for owner memcmp, `137` for sharePrice, `104` for shares, `dataSize: 169`). **This is tightly coupled to the SKR program's account layout** — if SKR upgrades the layout this breaks silently.

The Helius API key is read from `process.env.EXPO_PUBLIC_HELIUS_API_KEY` (Expo inlines `EXPO_PUBLIC_*` vars at bundle time). See `.env.example` for the variable name; the real key lives in a gitignored `.env`. If the env var is missing, the hook's `check()` throws inside its existing `try`/`catch`, which logs `SKR check error: ...` and sets `isStaker(false)` — the badges tab and the rest of the app keep working; only the `skr_staker` badge fails to auto-award. Don't move the throw to module scope; that would crash anything that imports this hook.

## Conventions

- TypeScript strict mode; path alias `@/*` → repo root (defined in `tsconfig.json`, currently underused — most code uses relative imports).
- Real-time UI everywhere: hooks use `onSnapshot` and return `{ data, loading }`. Keep that shape when adding new hooks.
- Inline `StyleSheet.create` per screen with a local `C = { ... }` color palette object. There is no shared theme module beyond `constants/theme.ts` (largely unused).
- Firestore writes always use `setDoc(..., { merge: true })` to preserve fields written by other code paths (e.g., the recovery logic). Don't switch to plain `setDoc` without merge.

## Product Decisions — DO NOT

These are settled product/legal decisions, not open questions. Re-litigate with the owner before changing any of them.

- **DO NOT add direct SOL or token payouts to users.** Direct on-chain rewards risk gambling / prize-regulation classification, which varies by country. The reward design is intentionally NFT badges + a points leaderboard. Any token-denominated reward needs legal review first.
- **DO NOT charge SKR (or any token) as a minting fee.** Gating activation behind a token purchase was explicitly rejected. The current 0.001 SOL transfer is the only sanctioned fee path.
- **DO NOT modify the squat angle thresholds (110° / 150° / 160°)** in `app/(tabs)/workout.tsx` without explicit coordination. These are clinical PT calibration values, not arbitrary numbers.
