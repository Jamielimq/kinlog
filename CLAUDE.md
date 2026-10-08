# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Kinlog — Expo (bare workflow) React Native fitness dApp targeting **Android / Solana Seeker**. AI-powered squat counting via on-device MediaPipe; achievements stored in Firestore and "minted" by paying SOL on Solana Mainnet. iOS is configured but not the primary target (the pose detector is Android-only).

Tagline: **"Move · Earn · Evolve"**. Built for the MONOLITH Solana Mobile Hackathon 2026, connected to RadiantsDAO. **Currently live on the Solana dApp Store**, Lifestyle category, version 1.3.3 (`versionCode 9`) — bumping these in `android/app/build.gradle` is a release-affecting change.

Subsystem reference — squat detection, Firestore data model, challenge flow, badge minting, MWA signing, licensing: `docs/ARCHITECTURE.md`.

## Commands

```bash
npm run start        # expo start (Metro)
npm run lint         # expo lint
npm --prefix functions run typecheck   # server (functions/) tsc
npm --prefix functions test            # server unit tests
firebase emulators:exec --only firestore,auth --project demo-kinlog "npm --prefix functions run test:emulator"   # rules and server
```

`npm run android` is **banned** — it invokes `npx expo run:android`. See Build Environment for the only sanctioned build path.

The app has no test runner. The `web` script exists but the app depends on a native Android module and the camera, so web/iOS will not be functional.

Release builds need `KINLOG_UPLOAD_STORE_FILE` / `_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` set in `android/gradle.properties` (gitignored; see `android/app/build.gradle`).

Firebase deploys (`firestore:rules`, `firestore:indexes`, `functions:<name>`; `--project kinlog-6549a`) need the owner's go-ahead each time. Deploy only what changed, and check `git status functions/src` first: a deploy uploads the working tree, not the commit. Never run `firebase functions:secrets:access` or print a secret; set secrets from a file (`--data-file`) or let the owner type them.

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

- **The calibration instrumentation was removed in 1.4.0**: the `POSE_DEBUG` logs and the (never enabled) per-rep frame capture in `workout.tsx`, and the timing fields and debug methods in `PoseLandmarkerModule.kt`. The measured cadence and the settled constants are recorded in `docs/ARCHITECTURE.md` section 1. A release build no longer writes `[POSE]` lines, so a new calibration pass needs its own instrumentation.

### Firestore data model
All paths are under `users/{walletBase58}`:
- Parent doc: `points`, `totalSquats`, `totalWorkouts`, `currentStreak`, `bestStreak`, `dailyReps`, `lastWorkoutDate` (all denormalized — see invariant above).
- `workouts/{auto}` — `{ exercise, reps, elapsed, createdAt }`. Source of truth for squat totals.
- `points_history/{id}` — `{ reason, amount, createdAt }`. Source of truth for points. Badge claims use fixed ids (`lb-<badge>`, `mb-<type>-<YYYYMM>`, `sb-<badge>-<cohort>`) so a retry can't add points twice; `li-*` entries are Locked In completion points written by the server only.
- `badges/{id}` — lifetime badges by catalog id (`ALL_BADGES`, hardcoded in `hooks/useBadges.ts`): `{ earned, earnedAt, mintedAt?, txSignature?, memo? }`, where `mintedAt` means claimed. Monthly badges are `month_<type>_<YYYYMM>` (`lib/record.ts`) and Square badges `<squareId>_<cohort>` (`lib/squareBadges.ts`), both `{ kind, earned, claimed, claimedAt?, txSignature?, memo?, pts? }`. `badges/<squareId>/grants/<cohort>` is written by the server when a pick settles; only the owner reads it.
- `goals/{daily|weekly|monthly}` — `{ current, total, lastResetDate }`. Written by the workout save (daily dated with today) and reset on read in `useGoals` if `lastResetDate` is older than the current day/week/month boundary; the old quest start and v1.3.3 read them. The Home and Goals screens don't show these documents: `useGoals` counts the goals from `workouts` since the earlier of this month's 1st and this week's Monday (device calendar). **Week starts Monday** (`(getDay() + 6) % 7`).
- `cache/skr_staking` — cached SKR stake account address.

### Workout write path (`workout.tsx::saveWorkout`)
This function bundles a lot of game logic; read it before changing related code.
- Daily idempotency: caps `effectiveReps` at `TARGET (30) − dailyReps`, so re-running won't double-count.
- Streak: same-day = unchanged; ≤24 h since last = +1; otherwise reset to 1.
- Increments `points` via Firestore `increment(pts)` with `POINTS_PER_REP = 5`.
- Calls `checkAndAwardBadges()`, which parses thresholds out of badge IDs (e.g., `squats_300` → 300, `streak_7` → 7). Adding a new threshold-style badge is just adding to `ALL_BADGES` with the right ID format.

### Badge claims
Every badge (lifetime, monthly, Square) is claimed the same way from the Badges or Goals tab (`context/ClaimsContext.tsx`): 0.001 SOL to the treasury `EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ` plus a memo naming the badge (`lib/badgeClaim.ts`), simulated before the wallet opens and confirmed after. The signature is kept on the phone (`lib/pendingClaims.ts`) from the moment the wallet sends it: a confirmed claim writes the badge record and its points in one Firestore transaction, a failed one is dropped, and the rest are checked again when either tab is opened and every 15 s. A claim that goes through shows no popup; only failures do. There is no on-chain badge yet; the memo is the record.

### Quests (legacy)
The old 3-Day / 7-Day quests (`challenges/{id}` catalog, `users/{wallet}/userChallenges/{id}` runs) can't be started in this version: Home shows only a run still going or waiting for its claim (`homeQuests` in `hooks/useChallenges.ts`), `/challenges` redirects to Home, and the quest screen has no start button. Workouts still update a run's progress (`hooks/challengeProgress.ts`), and a claim still pays the run's `mintFeeLamports` (0.001 SOL in both catalog entries) to the same treasury with a memo, then awards its points. The quest code goes in the next version.

### SKR staking detection (`hooks/useSkrStaking.ts`)
Detects whether the user has ≥1 SKR staked, which auto-awards the `skr_staker` badge. The user's `UserStake` account is a PDA derived from `["user_stake", STAKE_CONFIG, user, GUARDIAN_POOL]` under the SKR staking program (`SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ`), so detection is one `findProgramAddressSync` + one `getAccountInfo` — no transaction-history scan, no `getProgramAccounts`. A second `getAccountInfo(STAKE_CONFIG)` reads the current `share_price`, and `tokens = shares * sharePrice / 1e9`, `SKR = tokens / 1e6`.

Both `shares` (UserStake offset 105) and `share_price` (StakeConfig offset 137) are `u128` per the program IDL; the hook reads them as `lo + (hi << 64)` BigInts. Account size is 169 bytes for `UserStake`. **This is tightly coupled to the SKR program's account layout** — if SKR upgrades the layout this breaks silently. The IDL the offsets came from is mirrored in `program/idl.json` of the official `solana-mobile/react-native-samples/skr-staking` sample.

`EXPO_PUBLIC_HELIUS_API_KEY` is now optional: if set, the hook uses Helius RPC for higher rate limits, otherwise it falls back to `https://api.mainnet-beta.solana.com`. The hook also best-effort `deleteDoc`s the legacy `users/{addr}/cache/skr_staking` document on every run to drain dead data left over from the pre-PDA implementation; the delete is wrapped in its own try/catch so a rules denial or missing doc is silent.

### Locked In (`feat/locked-in`: program and server live on mainnet, app in progress)
Deposit-backed rework of the 3-Day / 7-Day Challenge: 100 SKR deposit + 0.001 SOL Fee, 30 squats a day, then one pick on a 5×5 board whose tier (Common / Rare / Legendary Square) comes from an ORE mining round, paid in ORE from a program vault. Full design: `docs/LOCKED_IN.md`. Revenue modelling lives in `docs/private/` (gitignored; never commit it).
- **Day boundary is 15:00 UTC (00:00 KST) for everything Locked In** — on-chain cohort times, server daily totals, app copy. The rest of the app still uses the device's local midnight; don't mix the two.
- **ORE mining program is `oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv`.** `mineRHF5r6S7HyD9SppBfVMXMavDkJsxwGesEvxZr2A` is the legacy v1 program; don't use it. ORE stake program (post-June-2026): `stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH`.
- **Four key roles.** Admin = Squads 2-of-3 (laptop key, jamielim.skr, isollim.skr; sorak.skr is a test phone and is not a member): upgrades, role rotation, limits, `fee_wallet`, deposit pause. Server keys (in `~/.config/kinlog/` and Secret Manager, never in the repo, never printed): **cohort creator** (creates cohorts within limits, pays their rent), **attester** (marks success, nothing else), **crank** (settle, retarget, return, close). No key can move deposits or reward ORE anywhere the program's rules don't send them.
- **Server:** `functions/` (Cloud Functions v2, `asia-northeast3`): `authNonce` / `authVerify` (Sign In With Solana, domain `kinlog.app`, custom token uid = wallet address), `onWorkoutCreate`, `everyMinute`, `daily`. Switches are in `config/ops`; a missing document means everything is off. Only workouts carrying `uid` and `rawReps` count toward Locked In. Details: `docs/LOCKED_IN.md` section 7.
- **Program invariants — never weaken:** the only way ORE leaves the reward vault is `claim_reward`; deposits go only back to the depositor; nothing leaves an SKR vault before the cohort ends (there is no cancel instruction).
- **Copy rules (Locked In screens):** English; no middle dots or em dashes; say "Square" and "Reward", never "box"; no multipliers, jackpot wording or dollar conversions; odds appear only on the join screen's ⓘ Reward odds sheet.
- Mainnet deploys, any transaction that spends SOL or ORE, and Squads transfers or setting changes need the owner's explicit go-ahead each time.

## Conventions

- TypeScript strict mode; path alias `@/*` → repo root (defined in `tsconfig.json`, currently underused — most code uses relative imports).
- Real-time UI everywhere: hooks use `onSnapshot` and return `{ data, loading }`. Keep that shape when adding new hooks.
- Inline `StyleSheet.create` per screen with a local `C = { ... }` color palette object. There is no shared theme module beyond `constants/theme.ts` (largely unused).
- Firestore writes always use `setDoc(..., { merge: true })` to preserve fields written by other code paths (e.g., the recovery logic). Don't switch to plain `setDoc` without merge.

## Product Decisions — DO NOT

These are settled product/legal decisions, not open questions. Re-litigate with the owner before changing any of them.

- **DO NOT add direct SOL or token payouts to users** — with exactly one owner-approved exception (2026-09-25): the **Locked In Reward (ORE)**. Direct on-chain rewards risk gambling / prize-regulation classification, which varies by country; otherwise the reward design stays NFT badges + a points leaderboard. The exception holds only while all of these stay true:
  - Picking a Square is free and has no losing outcome (the minimum tier is Common).
  - The reward budget is marketing budget, kept separate from Fee revenue; the vault is filled from the marketing budget.
  - The amount rule (1×, 2×, 20× the Fee's value, priced at cohort creation) and the per-cohort tier caps are public rules (`docs/LOCKED_IN.md`).
  Any other SOL or token payout is still forbidden.
- **DO NOT charge SKR (or any token) as a minting fee.** Gating activation behind a token purchase was explicitly rejected. **The Locked In deposit is not a fee:** it is returned 100%, pass or fail, to an address the program fixes to the depositor. Withholding or forfeiting any part of a deposit is forbidden.
- **Fees are SOL only, never SKR.** There are three, all project revenue: the Locked In **Fee** (0.001 SOL, paid inside the `deposit` instruction, non-refundable), the badge **claim fee** (0.001 SOL per claim, any badge kind), and the **quest claim fee** (0.001 SOL, only for quests started before this version, which can no longer start new ones). The badge and quest claim fees go to the treasury `EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ`.
- **DO NOT modify the squat angle thresholds (110° / 150°)** in `app/(tabs)/workout.tsx` without explicit coordination. These are clinical PT calibration values, not arbitrary numbers. On 2026-09-22 the owner (a physical therapist) authorised the current set directly: boundaries moved to `≤ 110°` / `≥ 150°`, front mode was removed so side view is the only supported capture, and a 0.5 visibility floor was added. On 2026-09-23, after on-device measurement, smoothing and multi-frame confirmation were removed entirely: judgement is the raw angle on a single frame (EMA 0.4 → median-3 → none). **The 110° and 150° values themselves have never changed** — that work existed only to stop the pipeline from masking them, and removing it was what finally stopped it. That approval covers those changes only; this clause still stands for any further change.
