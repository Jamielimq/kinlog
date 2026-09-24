# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kinlog — Expo (bare workflow) React Native fitness dApp targeting **Android / Solana Seeker**. AI-powered squat counting via on-device MediaPipe; achievements stored in Firestore and "minted" by paying SOL on Solana Mainnet. iOS is configured but not the primary target (the pose detector is Android-only).

Tagline: **"Move · Earn · Evolve"**. Built for the MONOLITH Solana Mobile Hackathon 2026, connected to RadiantsDAO. **Currently live on the Solana dApp Store**, Lifestyle category, version 1.1.0 (`versionCode 4`) — bumping these in `android/app/build.gradle` is a release-affecting change.

Subsystem reference — squat detection, Firestore data model, challenge flow, badge minting, MWA signing, licensing: `docs/ARCHITECTURE.md`.

## Commands

```bash
npm run start        # expo start (Metro)
npm run lint         # expo lint
```

`npm run android` is **banned** — it invokes `npx expo run:android`. See Build Environment for the only sanctioned build path.

There is no test runner configured. The `web` script exists but the app depends on a native Android module and the camera, so web/iOS will not be functional.

Release builds need `KINLOG_UPLOAD_STORE_FILE` / `_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` set in `android/gradle.properties` (gitignored; see `android/app/build.gradle`).

## Build Environment

- **Always export Java 17 before any Android build** — Gradle here will not work on a different JDK:
  ```bash
  export JAVA_HOME=$(/usr/libexec/java_home -v 17)
  ```
- **Banned commands — never run these, in any variant, even when asked.** Raise the consequence and get explicit confirmation first:
  - `npx expo prebuild`
  - `npx expo run:android` (including `--variant release`, `--device`, and via `npm run android`)
  - `./gradlew clean`

  `expo run:android` can judge the project malformed and wipe all of `android/` before re-running prebuild. That has already happened here, destroying gitignored files that are not recoverable from git: `google-services.json`, the upload keystore, the `KINLOG_UPLOAD_*` entries in `android/gradle.properties`, the Kotlin `PoseLandmarker` module, and the MediaPipe `.task` model asset. `./gradlew clean` wipes codegen output for `react-native-gesture-handler`, `react-native-reanimated`, and `react-native-worklets`, and the project will not rebuild cleanly afterward.
- **The only release build path.** For a fresh build, delete just the APK first:
  ```bash
  export JAVA_HOME=$(/usr/libexec/java_home -v 17)
  rm -f android/app/build/outputs/apk/release/app-release.apk
  cd android && ./gradlew assembleRelease
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
- The module exposes `initialize(videoMode) / detectPose(filePath) / release`. It returns only the 6 leg landmarks (hip/knee/ankle, indices 23–28). Running mode is chosen at init: **`RunningMode.VIDEO`** carries tracking state between frames so the heavy person detector only re-runs when tracking is lost; `IMAGE` re-runs it every frame. `detectPose` decodes downscaled (`inSampleSize` sized so the short edge stays ≥ 480 px — the graph resizes to 256×256 internally anyway) and releases the bitmap rather than waiting for GC.
- JS bridge: `hooks/usePoseLandmarker.ts` (initialize on mount, release on unmount, plus a pure `calcAngle` helper).
- Workout loop in `app/(tabs)/workout.tsx`: every 100 ms, take a `react-native-vision-camera` snapshot at quality 30, write it into the `kinlog-snapshots` directory under the app cache, pass the path to `detectPose`, then **delete the file in the `finally` block**. Entering the screen sweeps that directory once to reclaim anything a crashed session left behind — it is ours alone, so no other cache is ever touched. The `useFrameProcessor` defined there is a no-op — detection happens via snapshots, **not** the frame processor. A `detectingRef` guard prevents overlapping detections.
- **Side view only.** `measureSide()` picks the leg with higher summed landmark visibility and returns that leg's angle, its three joints, and its weakest joint confidence. A frame whose `minVis < MIN_VISIBILITY` (0.5) — or that yields no pose at all — is excluded from judgement: the angle readout holds its last measured value and the phase is preserved. Once frames have been excluded continuously for `TRACKING_WARN_MS` (1 s), the phase badge switches to a "step back" warning, so a stalled rep counter always has a visible reason.
- **Judgement principle (owner's, 2026-09-23): missing a rep mid-workout is worse than counting an extra one or two — but the counter must never advance while the user is standing still.** Read it as an asymmetric cost: bias toward counting, and spend the safety budget on the standing-still case, not on suppressing real reps. Any change here is verified against a standing-still set (sway, arm movement, weight shifts) whose correct answer is **0**.
- Squat state machine on the **raw** knee angle, **one frame, no smoothing**:
  - `up → down` when the knee angle is `≤ 110°` **and** the hip has descended by at least `HIP_DROP_RATIO` (20%) of torso length.
  - `down → up` (one rep) when the knee angle is `≥ 150°`. No hip term here.
  - These thresholds are intentional (clinical PT calibration per README) — coordinate before changing them.
- **Why the hip term exists.** Knee angle alone cannot separate a squat from a standing knee raise: lifting one foot bends that knee well past 110°. On device this counted 8 phantom reps during a standing-still set, and the logged joints showed exactly why — the hip stayed at y≈0.54 for all 8 while the *ankle* rose from 0.91 to 0.74. A real squat in the same session moved the hip from ≈0.54 to ≈0.73 with the ankle planted at ≈1.07.
- **Standing baseline** (`standSamplesRef` / `baselineRef`): frames with knee `≥ 150°` are buffered for `STAND_WINDOW_MS` (5 s); the baseline is the sample with the **highest hip** (smallest `y`) among them, and torso length is taken from that same frame. Picking the highest hip rather than the latest keeps a slouched moment while getting set from becoming the reference, and that frame is also the most upright — which is what makes `|shoulder.y − hip.y|` a fair torso length. Hip drop and torso are both in normalized `y`, so no aspect-ratio correction is needed. Nothing updates while the knee is bent, so the baseline freezes on its own during a descent.
- **Two sanity checks guard the landmarks themselves**, both calibrated from on-device logs:
  - *Anatomical ordering* (`jointsPlausible`, `ORDER_TOLERANCE` 0.03): a frame is discarded — exactly like a low-confidence one — if the shoulder sits below the hip, or the hip or knee below the ankle (`y` grows downward). Hip-below-knee is **not** checked; that is a legitimate deep squat. This matters most in the seconds after Start, when no baseline exists yet and the hip condition is therefore still off, so a scrambled frame would otherwise be judged on knee angle alone. Slack measured at the bottom of real squats was 0.068 at the tightest; the scrambled frames sat 0.045–0.209 the wrong way.
  - *Torso floor* (`TORSO_MIN` 0.15): a standing sample whose torso measures shorter than this cannot become the baseline. Across four clean sets the baseline torso never fell below 0.210, while bad frames measured 0.030–0.141. Barring the sample is deliberate — skipping the hip condition instead would let exactly the frames this is meant to catch through on knee angle alone.
- **When torso length cannot be measured** (shoulder below the confidence floor, or no standing frame seen yet) the hip term is **skipped** and the knee angle alone decides. That follows the judgement principle above: a missed rep is the worse error.
- **Why no filter.** Both filters tried made counting worse at the ~4 fps this pipeline actually achieves. `EMA_ALPHA = 0.4` attenuated a real 66–178° swing to 89–155°, leaving the 150° standing threshold barely reachable, so most reps at a 2 s cadence went uncounted. A median-3 preserved amplitude but discarded single-frame peaks, merging two reps into one whenever the top of a rep lasted one frame. Multi-frame confirmation had the same shape of cost: it needs ≥ 6 qualifying frames per rep, and a 2 s rep only supplies ~8.6 frames in total. Each bought noise rejection the confidence gate already provides, and paid for it in missed reps — the wrong side of the principle above.
- **The 0.5 confidence gate is therefore the only thing standing between a bad landmark frame and a phantom rep.** Do not loosen it without re-running the standing-still set.

- **Calibration instrumentation is still in `workout.tsx`**, between the `POSE DEBUG BEGIN`/`END` markers. `POSE_DEBUG` is **on** (per-frame `[POSE]` lines to logcat plus a per-session summary — `adb logcat -s ReactNativeJS:V | grep POSE`), while `POSE_DEBUG_FRAMES` is **off**: saving per-rep JPEGs to the device would contradict the screen's own "This video is not recorded or saved". Both come out together before submission; when they do, record the measured cadence and the settled constants in `docs/ARCHITECTURE.md` first, or the numbers lose their provenance.

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
Detects whether the user has ≥1 SKR staked, which auto-awards the `skr_staker` badge. The user's `UserStake` account is a PDA derived from `["user_stake", STAKE_CONFIG, user, GUARDIAN_POOL]` under the SKR staking program (`SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ`), so detection is one `findProgramAddressSync` + one `getAccountInfo` — no transaction-history scan, no `getProgramAccounts`. A second `getAccountInfo(STAKE_CONFIG)` reads the current `share_price`, and `tokens = shares * sharePrice / 1e9`, `SKR = tokens / 1e6`.

Both `shares` (UserStake offset 105) and `share_price` (StakeConfig offset 137) are `u128` per the program IDL; the hook reads them as `lo + (hi << 64)` BigInts. Account size is 169 bytes for `UserStake`. **This is tightly coupled to the SKR program's account layout** — if SKR upgrades the layout this breaks silently. The IDL the offsets came from is mirrored in `program/idl.json` of the official `solana-mobile/react-native-samples/skr-staking` sample.

`EXPO_PUBLIC_HELIUS_API_KEY` is now optional: if set, the hook uses Helius RPC for higher rate limits, otherwise it falls back to `https://api.mainnet-beta.solana.com`. The hook also best-effort `deleteDoc`s the legacy `users/{addr}/cache/skr_staking` document on every run to drain dead data left over from the pre-PDA implementation; the delete is wrapped in its own try/catch so a rules denial or missing doc is silent.

## Conventions

- TypeScript strict mode; path alias `@/*` → repo root (defined in `tsconfig.json`, currently underused — most code uses relative imports).
- Real-time UI everywhere: hooks use `onSnapshot` and return `{ data, loading }`. Keep that shape when adding new hooks.
- Inline `StyleSheet.create` per screen with a local `C = { ... }` color palette object. There is no shared theme module beyond `constants/theme.ts` (largely unused).
- Firestore writes always use `setDoc(..., { merge: true })` to preserve fields written by other code paths (e.g., the recovery logic). Don't switch to plain `setDoc` without merge.

## Product Decisions — DO NOT

These are settled product/legal decisions, not open questions. Re-litigate with the owner before changing any of them.

- **DO NOT add direct SOL or token payouts to users.** Direct on-chain rewards risk gambling / prize-regulation classification, which varies by country. The reward design is intentionally NFT badges + a points leaderboard. Any token-denominated reward needs legal review first.
- **DO NOT charge SKR (or any token) as a minting fee.** Gating activation behind a token purchase was explicitly rejected. The current 0.001 SOL transfer is the only sanctioned fee path.
- **DO NOT modify the squat angle thresholds (110° / 150°)** in `app/(tabs)/workout.tsx` without explicit coordination. These are clinical PT calibration values, not arbitrary numbers. On 2026-09-22 the owner (a physical therapist) authorised the current set directly: boundaries moved to `≤ 110°` / `≥ 150°`, front mode was removed so side view is the only supported capture, and a 0.5 visibility floor was added. On 2026-09-23, after on-device measurement, smoothing and multi-frame confirmation were removed entirely: judgement is the raw angle on a single frame (EMA 0.4 → median-3 → none). **The 110° and 150° values themselves have never changed** — that work existed only to stop the pipeline from masking them, and removing it was what finally stopped it. That approval covers those changes only; this clause still stands for any further change.
