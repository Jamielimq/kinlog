# Kinlog Architecture Reference

A current-state map of the subsystems that upcoming work touches: squat detection, the 3-Day/7-Day Challenge,
the daily workout record, badge issuance, SKR staking verification, MWA transaction signing, and licensing.
Every claim below is a description of code as it exists today, with `file:line` citations so you can jump
straight to the source instead of re-deriving it.

Accurate as of app version **1.3.3** (`versionCode 9`, `android/app/build.gradle:95-96`), commit `e383695`.
Companion documents: `CLAUDE.md` (working rules and settled product decisions), `README.md` (product overview).

| Section | Primary files |
|---|---|
| [1. Squat detection](#1-squat-detection) | `app/(tabs)/workout.tsx`, `hooks/usePoseLandmarker.ts`, `PoseLandmarkerModule.kt` |
| [2. Challenge / Quests](#2-3-day--7-day-challenge-quests) | `hooks/useStartChallenge.ts`, `hooks/challengeProgress.ts`, `hooks/useClaimChallengeReward.ts` |
| [3. Workout record storage](#3-daily-workout-record-storage) | `app/(tabs)/workout.tsx`, `hooks/useGoals.ts`, `context/WalletContext.tsx` |
| [4. Badge issuance](#4-badge-issuance) | `hooks/useBadges.ts`, `app/(tabs)/badges.tsx` |
| [5. SKR staking](#5-skr-staking-verification) | `hooks/useSkrStaking.ts` |
| [6. MWA signing](#6-mwa-transaction-signing) | `context/WalletContext.tsx` |
| [7. Licensing](#7-license-layout) | `LICENSE`, `docs/terms.html` |

---

## 1. Squat detection

### Pipeline

Detection runs on **camera snapshots, not the frame processor**. `useFrameProcessor` is declared at
`app/(tabs)/workout.tsx:232-234` as an empty worklet and is never passed to `<Camera>`.

The loop lives at `app/(tabs)/workout.tsx:240-274`:

1. `setInterval` every **100 ms** (`:271`).
2. `detectingRef` guard (`:236`, `:244-245`) skips a tick while a previous detection is still in flight;
   the `finally` at `:268-270` always clears it.
3. `cameraRef.current.takeSnapshot({ quality: 30 })` (`:247`) writes a JPEG to the camera cache.
4. `detect('file://' + photo.path)` (`:249`) crosses the bridge to the native module.
5. The returned landmarks are converted to one knee angle, which drives the state machine.

`catch` at `:266-267` swallows all errors silently (snapshot failure, decode failure, native rejection).

### JS bridge — `hooks/usePoseLandmarker.ts`

- `usePoseLandmarker()` calls `PoseLandmarker.initialize()` on mount and `release()` on unmount (`:33-41`).
- `detect(...)` returns `null` when uninitialized and swallows native rejections (`:43-50`). Note the parameter
  is named `base64Image` (`:43`) but the value passed is a **file path**.
- `calcAngle(a, b, c)` (`:18-27`) is a pure 2D interior-angle helper in degrees, already rounded. `z` is ignored.
- `PoseLandmarks` (`:8-15`) exposes exactly six named joints, each `{ x, y, z, visibility }`.

### Native module — `android/app/src/main/java/com/kinlog/app/PoseLandmarkerModule.kt`

- Module name `"PoseLandmarker"` (`:16`), registered by `PoseLandmarkerPackage.kt:9-12` via `MainApplication.kt`.
- `RunningMode.IMAGE`, `setNumPoses(1)`, model asset `pose_landmarker_lite.task` (`:21-31`). No custom
  detection/presence/tracking confidence is set, so MediaPipe defaults apply.
- Preprocessing (`:46-53`): strip `file://` → `BitmapFactory.decodeFile` → `BitmapImageBuilder`. There is **no
  rotation, EXIF, mirror, or resize handling**, and `lm.detect()` runs synchronously on the native-modules thread.
- Empty result → `promise.resolve(null)` (`:56-59`), which the JS loop skips on.
- Returns **only landmark indices 23–28** (`:61-83`): `leftHip` 23, `rightHip` 24, `leftKnee` 25, `rightKnee` 26,
  `leftAnkle` 27, `rightAnkle` 28. Coordinates are normalized to the image (`y` grows downward).
- **`z` is hard-coded to `0.0`** (`:69`) — every angle in the app is a 2D image-plane angle.
- `visibility` is the real MediaPipe value, defaulting to `0.0` when absent (`:70-75`).
- `release()` (`:91-95`) only nulls the reference; it never calls `close()` on the MediaPipe graph.
- Gradle dependency: `com.google.mediapipe:tasks-vision:0.10.14` (`android/app/build.gradle:183`).

### Angle computation and camera mode

| Mode | Function | Behavior |
|---|---|---|
| `side` (default) | `calcSideAngle` — `app/(tabs)/workout.tsx:152-165` | Sums `visibility` of hip+knee+ankle per leg, measures the higher-scoring leg. `>=` ties to the left leg. No minimum-visibility floor. |
| `front` | `calcFrontAngle` — `app/(tabs)/workout.tsx:168-173` | Averages both legs' knee angles. Visibility is ignored. |

`cameraMode` defaults to `'side'` (`:181`, ref mirror at `:194`). Note that `useCameraDevice('front')` (`:180`)
means the **physical camera is always the selfie camera** regardless of mode; `cameraMode` only changes the math.

### State machine and thresholds

```
up   --(kneeAngle < 110)--------------------------> down
down --(kneeAngle > 150 side | > 160 front)------->  up   [+1 rep]
```

| Constant | Value | Location |
|---|---|---|
| Down threshold | `kneeAngle < 110` | `app/(tabs)/workout.tsx:259` |
| Up threshold (side) | `kneeAngle > 150` | `app/(tabs)/workout.tsx:261` |
| Up threshold (front) | `kneeAngle > 160` | `app/(tabs)/workout.tsx:261` |
| Detection interval | `100` ms | `app/(tabs)/workout.tsx:271` |
| Snapshot quality | `30` | `app/(tabs)/workout.tsx:247` |
| Daily target / auto-stop | `TARGET = 30` | `app/(tabs)/workout.tsx:20`, `:264` |
| Points per rep | `POINTS_PER_REP = 5` | `app/(tabs)/workout.tsx:19` |

One `up → down → up` cycle is one rep (`:259-264`). Reaching `TARGET` calls `stopSession()` from inside the
interval callback. Session lifecycle: `startSession` (`:276-280`), `stopSession` (`:208-230`),
`resetSession` (`:282-288`); the screen is held awake by `useKeepAwake()` (`:177`).

The `Product Decisions — DO NOT` section of `CLAUDE.md` pins the 110° / 150° / 160° values as clinical PT
calibration — coordinate before changing them.

### What the pipeline does not do

Relevant to any accuracy work, all of the following are **absent**:

- No smoothing of any kind — no EMA, moving average, or median filter. The raw per-frame angle drives the
  comparison directly.
- No consecutive-frame confirmation, no debounce, no minimum time in phase, no rep cooldown. A single frame
  crossing a threshold flips the phase and, on the up-transition, immediately counts a rep.
- No standing baseline or reference pose. `setAngle(180)` at `:278`/`:287` is UI initialization only.
- No hip-descent, torso-length, or scale-normalization logic. Hips are used solely as the first vertex of the
  knee angle.
- No shoulder landmarks. Indices 11/12 are never requested by the native module and appear nowhere in the repo,
  so torso length is not computable from the current bridge output.
- No visibility floor or confidence gate. Visibility only selects which leg to measure in side mode.
- No validation of pose presence beyond `if (!landmarks) return` (`:250`).
- Snapshot temp files are never deleted during a session.

---

## 2. 3-Day / 7-Day Challenge (Quests)

The feature is called **"Quests" in the UI** and **"challenges" in code and Firestore**. Screens live at
`app/challenges/index.tsx` (list) and `app/challenges/[id].tsx` (detail, day grid, claim button). They sit
outside the tab bar — `app/(tabs)/_layout.tsx` has no Challenges tab, so the only entry point is the Home screen
(`app/(tabs)/index.tsx:163`, `:183`, `:207`, `:242-260`).

### Catalog: `challenges/{challengeId}`

A top-level collection, admin-seeded (no seeding script exists in the repo). Shape at
`hooks/useChallenges.ts:26-41`:

`name`, `tagline`, `description`, `requirementType`, `requirementDays`, `requirementDailyReps`, `bonusPoints`,
`mintFeeLamports`, `rarity`, `nft { symbol, uriTemplate, gradientFrom, gradientTo, romanNumeral }`, `isActive`,
`displayOrder`, `createdAt`.

Known ids: `three_day_challenger`, `seven_day_warrior` (referenced from `hooks/useBadges.ts:38-39`).
Read at `hooks/useChallenges.ts:152-169` with `where('isActive','==',true)` + `orderBy('displayOrder')`.

### Instance: `users/{wallet}/userChallenges/{autoId}`

Shape at `hooks/useChallenges.ts:63-78`:

| Field | Type | Notes |
|---|---|---|
| `challengeId` | string | catalog id |
| `status` | `'active' \| 'completed' \| 'failed' \| 'claimed'` | |
| `sequence` | number | Nth attempt of this challenge |
| `startedAt` | number (ms) | |
| `startTxSignature` | string | on-chain proof of enrollment |
| `startMemo` | string | `kinlog:start:{id}:{ts}:{seq}` |
| `requirementSnapshot` | object | `{ requirementType, requirementDays, requirementDailyReps, bonusPoints, mintFeeLamports }` — frozen at join time |
| `progress` | object | `{ dayIndex, daysLog: Record<'YYYY-MM-DD', { reps, met }>, lastProgressDate }` |
| `completedAt` / `failedAt` / `claimedAt` | number | set on the matching transition |
| `bonusPointsAwarded` | number | written on claim |
| `claimTxSignature` | string | written on claim |
| `nftMint` / `migratedAt` / `migrationVersion` | `null` / `null` / `1` | forward-looking, written on claim (`hooks/useClaimChallengeReward.ts:145-147`) |

### Join — `hooks/useStartChallenge.ts`

1. Query the most recent instance: `where('challengeId','==',id)`, `orderBy('sequence','desc')`, `limit(1)`
   (`:58-65`). The composite index is declared in `firestore.indexes.json:11-18`.
2. Guard: throws `'This challenge is already in progress.'` if the last instance is `active` (unexpired) or
   `completed` (`:74-79`).
3. An idle-expired `active` instance is best-effort flipped to `status: 'failed'` first (`:80-93`).
4. Build the memo `kinlog:start:{catalogId}:{startedAt}:{nextSequence}` (`:97-98`).
5. **On-chain transaction (`:102-124`): Memo program only** — no transfer, so the user pays only the base network
   fee. Signed through `authorizeAndSign` + `wallet.signAndSendTransactions`; the signature is checked non-empty
   at `:126`.
6. Day 1 is backfilled from `users/{addr}/goals/daily.current` if today already meets `requirementDailyReps`
   (`:132-140`).
7. **Only after the transaction succeeds** is the instance written with `addDoc` (`:164-167`).

### Progress — `hooks/challengeProgress.ts`

Progress is driven by workout saves, not by a timer. `app/(tabs)/workout.tsx:141-146` calls
`updateChallengeProgress(address, newDailyReps, now)` inside a try/catch — a failure here must not fail the
workout save.

- Local-day helpers `localDateKey` / `localDayStartMs` / `elapsedDays`, `DAY_MS = 86400000` (`:32-48`).
- Fetches `where('status','==','active')` under `users/{addr}/userChallenges` (`:127-136`).
- `computeOutcome` (`:59-102`):
  - Expiry: `elapsed > req.requirementDays - 1` → `failed` (`:72`).
  - Today's entry is an absolute overwrite: `daysLog[todayKey] = { reps: todayDailyReps, met: todayDailyReps >= req.requirementDailyReps }` (`:81-84`).
  - Completion: count of `met` days `>= requirementDays` → `completed` + `completedAt` (`:88-96`).
- Requirements are read from the instance's `requirementSnapshot`, **not** the live catalog (`:13-15`).
- Patch applied with `setDoc(..., { merge: true })` (`:106-125`, `:145-149`).

The view layer adds a derived status on top: `deriveEffectiveStatus` (`hooks/useChallenges.ts:126-143`) shows an
idle-expired `active` instance as `failed`, and splits `claimed` into `completed_today` vs `available`
(re-startable). `progressPct` / `daysRemaining` at `:201-210`.

### Claim — `hooks/useClaimChallengeReward.ts`

Invoked from `app/challenges/[id].tsx:180-187`.

1. Double guard (`:66-87`): the view status must be `completed` **and** a fresh `getDoc` re-read must agree.
2. `awardedPoints = view.catalog.bonusPoints` — the **live** catalog, not the snapshot (`:91`).
3. Memo `kinlog:claim:{challengeId}:{instanceId}:{sequence}`; `lamports = instance.requirementSnapshot.mintFeeLamports` (`:93-94`).
4. **On-chain transaction, two instructions (`:98-127`)**: `SystemProgram.transfer` to the treasury
   `EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ` (`:40-42`) plus a Memo instruction
   (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`, `:43-45`). Sent via `wallet.signAndSendTransactions`;
   signature checked non-empty at `:129`. **No Metaplex / NFT mint instruction** — cNFT/Bubblegum is deferred
   (header comment `:3`, `:9-12`).
5. Claim write (`:138-150`). This one is fatal if it fails; `:151-161` surfaces the transaction signature to the
   user so a paid-but-unrecorded claim is recoverable.
6. Best-effort points (`:164-177`): `users/{addr}.points = increment(awardedPoints)` plus a `points_history` doc
   with `reason: 'Claimed quest: {name}'`.
7. Best-effort badge (`:180-197`): `ALL_BADGES.find(b => b.questId === catalog.id)` →
   `users/{addr}/badges/{badgeId}` set to `{ earned: true, earnedAt, mintedAt }` when not already earned.

### Reward vs. cost

- **Reward**: `catalog.bonusPoints`, plus the badge `challenge_squat_3day` ("3-Day Challenger (Squat)", Uncommon)
  or `challenge_squat_7day` ("7-Day Warrior (Squat)", Rare) — `hooks/useBadges.ts:38-39`, both `pts: 0`,
  `mintFeeSOL: 0`. Repeat completions render as a ×N count derived from claimed instances
  (`hooks/useBadges.ts:113-132`, `:141`).
- **Cost**: the user pays `mintFeeLamports` to the treasury at claim time. The detail screen states this at
  `app/challenges/[id].tsx:262` ("Reward: +N points") and `:268` ("Reward fee: X.XXX SOL (charged on claim)").
- Both `startTxSignature` and `claimTxSignature` are surfaced as Solscan deep links
  (`app/challenges/[id].tsx:189-191`, `:336-360`).

### Bottom action states

`app/challenges/[id].tsx:194-210`: Connect Wallet → Start Quest → "Go to Workout →" → "Claim Reward →" →
"Try Again" (failed) → "Available tomorrow" (claimed today) → "Start Again".

---

## 3. Daily workout record storage

### Firebase initialization

There is **no JS Firebase config file and no Firebase environment variables**. The app uses the native React
Native Firebase SDK, configured from `google-services.json` via `app.json:26` (`googleServicesFile`) with the
`@react-native-firebase/app` plugin (`app.json:44`). Every module obtains the database with
`getFirestore(getApp())`; `initializeApp()` is never called from JS. The project id is in `.firebaserc`.

The only environment variable read anywhere in app code is **`EXPO_PUBLIC_HELIUS_API_KEY`**
(`hooks/useSkrStaking.ts:6`), declared in `.env.example`. Other `process.env` reads are `EXPO_OS` checks in
`components/external-link.tsx:14` and `components/haptic-tab.tsx:10`.

### Collections under `users/{walletBase58}`

The document id is always the **base58 wallet address** (see §6). Subcollections are the source of truth; the
parent document is a denormalized cache (`CLAUDE.md`).

#### Parent document `users/{wallet}`

| Field | Type | Written by | Read by |
|---|---|---|---|
| `points` | number (via `increment()`) | `workout.tsx:103`, `badges.tsx:117`, `useClaimChallengeReward.ts:167`, `usePoints.ts:54`; absolute re-derive at `WalletContext.tsx:135,145` | `hooks/usePoints.ts:30` |
| `totalSquats` | number | `workout.tsx:97`, `WalletContext.tsx:136` | recovery path only |
| `totalWorkouts` | number | `workout.tsx:98`, `WalletContext.tsx:137` | recovery path only |
| `currentStreak` | number | `workout.tsx:99`, `WalletContext.tsx:139` | recovery path only |
| `bestStreak` | number | `workout.tsx:100`, `WalletContext.tsx:138` | recovery path only |
| `lastWorkoutDate` | number (ms) | `workout.tsx:101` writes local midnight; `WalletContext.tsx:140` writes the max workout `createdAt` | `workout.tsx:74` |
| `dailyReps` | number | `workout.tsx:102`, `WalletContext.tsx:141` | `workout.tsx:76` |
| `createdAt` | number (ms), once | `WalletContext.tsx:79-80` | same function |
| `updatedAt` | number (ms) | all of the above writers | nothing |

All writes use `setDoc(..., { merge: true })`.

#### `users/{wallet}/workouts/{autoId}` — the daily workout record

Written **only** at `app/(tabs)/workout.tsx:115-117`, unconditionally (even when `effectiveReps === 0`):

```ts
{ exercise: 'squat', reps: effectiveReps, elapsed, createdAt: now }
```

`exercise` string, `reps` number (post-cap), `elapsed` seconds, `createdAt` ms epoch.
Read by `hooks/useUserStats.ts:107-117` (full-collection `onSnapshot`, recomputes stats client-side),
`hooks/useWeeklyChart.ts:35-52` (Monday–Sunday range query), and `context/WalletContext.tsx:91-108` (recovery).

#### `users/{wallet}/points_history/{autoId}`

`{ reason: string, amount: number, createdAt: number }` — typed at `hooks/usePoints.ts:5-10`.
Writers: `workout.tsx:108-112` (`Completed N squats`), `badges.tsx:118-121` (`Claimed badge: …`),
`useClaimChallengeReward.ts:170-174` (`Claimed quest: …`), `usePoints.ts:57-58` (`addPoints`, no screen callers).
Readers: `hooks/usePoints.ts:35-40` (desc, limit 20 → `profile.tsx:29`, `index.tsx:50`),
`hooks/useUserStats.ts:98-106`, `WalletContext.tsx:86-89`.

#### `users/{wallet}/badges/{badgeId}`

`earned: boolean`, `earnedAt: number`, `mintedAt: number`, `txSignature: string`. `nftMint` is read at
`hooks/useBadges.ts:103` but **never written**. Writers: `workout.tsx:45,51,55`, `badges.tsx:38-42`,
`badges.tsx:108-112`, `useClaimChallengeReward.ts:186-190`. Reader: `hooks/useBadges.ts:94-111` — only documents
with a truthy `earned` enter the map.

#### `users/{wallet}/goals/{daily|weekly|monthly}`

`current: number`, `total: number`, `lastResetDate: number`, plus `tag` / `title` / `color` written at seed time.
Writers: `workout.tsx:123-125` (weekly), `:130-132` (monthly), `:135-137` (daily — note it does not write
`lastResetDate`), and `hooks/useGoals.ts:45,57,70` (resets) / `:80-86` (seeding).
Readers: `hooks/useGoals.ts:75-112` → `goals.tsx:17`, `index.tsx:51`, `challenges/[id].tsx:69`;
`workout.tsx:120,127`; `hooks/useStartChallenge.ts:132-135`.

#### `users/{wallet}/userChallenges/{autoId}`

See §2.

#### `users/{wallet}/cache/{cacheId}` — legacy, delete-only

`hooks/useSkrStaking.ts:99` deletes `cache/skr_staking` on every run. Nothing writes or reads it any more.

### `saveWorkout` — `app/(tabs)/workout.tsx:62-149`

Boundary helpers: `getTodayStart` local midnight (`:24-26`), `getWeekStart` **Monday-based**
`d.setDate(d.getDate() - ((d.getDay()+6)%7))` (`:27-29`), `getMonthStart` (`:30-32`), `getDaysInMonth` (`:33-36`).

1. Read `users/{addr}` (`:71`).
2. **Daily idempotency cap** (`:74-78`): `alreadyWorkedOutToday = lastWorkoutDate >= todayStart`;
   `dailyReps = alreadyWorkedOutToday ? userData.dailyReps : 0`; `remainingToday = max(TARGET - dailyReps, 0)`;
   `effectiveReps = min(reps, remainingToday)`. At most 30 credited reps per calendar day; a further session
   yields `effectiveReps === 0`, which the UI renders as the "already" modal (`:218-222`).
3. **Streak** (`:80-88`): same day → unchanged; `lastWorkoutDate >= todayStart - 86400000` → `+1`; otherwise
   reset to `1`. `bestStreak = max(previous, new)`.
4. **Parent write** (`:96-105`): absolute values for `totalSquats` / `totalWorkouts` / `currentStreak` /
   `bestStreak` / `lastWorkoutDate` / `dailyReps`, and `points: increment(pts)`. `increment()` is used for points
   only; the other counters are read-modify-write.
5. `points_history` doc only when `effectiveReps > 0` (`:107-113`); the `workouts` doc always (`:115-117`).
6. Weekly and monthly goals are written only on the first session of the day (`:119-133`), each with a
   `lastResetDate` staleness check; the daily goal is written every time (`:135-137`).
7. `checkAndAwardBadges(address, newTotalSquats, newStreak)` (`:139`) — see §4.
8. `updateChallengeProgress(address, newDailyReps, now)` in try/catch, best-effort (`:141-146`).
9. Returns `{ effectiveReps }`.

### Goal resets — `hooks/useGoals.ts:35-73`

- Daily: reset `{ current: 0, lastResetDate: todayTs }` when `lastResetDate < localMidnight` (`:41-46`).
- Weekly: **week starts Monday** — `ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7))` (`:51`), reset at `:57`.
- Monthly: `ms.setDate(1)` (`:63`); the reset also rewrites `total` to the current month's day count (`:69-70`).
- A collection `onSnapshot` then seeds `DEFAULT_GOALS` if empty (`:76-88`) or maps documents, preferring the
  stored `total` (`:94`).

### Re-derivation invariant — `context/WalletContext.tsx:67-153`

`initUserInFirestore` runs on every authorize. It stamps `createdAt`/`updatedAt` (merge-only), then re-derives
`points` from `points_history` (`:86-89`), and `totalSquats` / `totalWorkouts` / `lastWorkoutDate` / `dailyReps` /
`bestStreak` / `currentStreak` from `workouts` (`:91-130`), writing back only fields where the derived value
exceeds the stored one (`:134-146`). Keep subcollections authoritative when adding new write paths.

### Security rules

Firestore security rules live in **`firestore.rules`**, wired through `firebase.json:3`. Composite indexes are
declared in `firestore.indexes.json`.

Collections addressed by the rules file: `challenges`, `users/{wallet}`, and the `badges`, `goals`, `workouts`,
`points_history`, `userChallenges`, and `cache` subcollections, plus `leaderboard`.

Per-collection access conditions are intentionally not reproduced here — read `firestore.rules` directly, since a
stale copy of access semantics in a document is worse than none.

---

## 4. Badge issuance

### Catalog — `hooks/useBadges.ts:36-78`

34 badges. `NFT_DEFAULTS` (`:29-34`) = `{ symbol: 'KINLOG', uri: '', sellerFeeBasisPoints: 250, mintFeeSOL: 0.001 }`;
each badge overrides `uri` to `https://kinlog.app/nft/{id}.json`.

| Category | Count | Ids | Award criterion |
|---|---|---|---|
| `challenge` | 2 | `challenge_squat_3day`, `challenge_squat_7day` | quest claim, matched by `questId` |
| `squats` | 14 | `squats_30` … `squats_10950` | `totalSquats >= N` |
| `streak` | 14 | `streak_7` … `streak_365` | `currentStreak >= N` |
| `special` | 4 | `first_rep`, `perfect_week`, `perfect_month`, `skr_staker` | see below |

Squat thresholds: 30, 60, 90, 150, 300, 600, 900, 1500, 2100, 3000, 4500, 6000, 9000, 10950.
Streak thresholds: 7, 14, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 365.

Special badges: `first_rep` (`totalSquats >= 1`), `skr_staker` (see §5), and `perfect_week` / `perfect_month`,
which exist in the catalog but have **no award logic anywhere** — the placeholder comment is at
`app/(tabs)/workout.tsx:57-58`.

### Award paths

- **Threshold badges** — `checkAndAwardBadges` (`app/(tabs)/workout.tsx:38-60`), called from `saveWorkout`.
  The threshold is parsed out of the badge id: `parseInt(badge.id.split('_')[1])` (`:43`, `:49`). Adding a new
  threshold badge therefore only requires an `ALL_BADGES` entry with the right id format. Writes
  `{ earned: true, earnedAt }` with merge.
- **`skr_staker`** — `app/(tabs)/badges.tsx:35-44`, auto-written when `useSkrStaking().isStaker` is true.
- **Quest badges** — `hooks/useClaimChallengeReward.ts:181-194`.

### Minting — `app/(tabs)/badges.tsx::handleMint` (`:74-135`)

**There is no real NFT mint instruction.** The transaction is a single SOL transfer; nothing creates a mint
account, and no Token/Metaplex/Bubblegum instruction is built. `nftMint` is never written.
`BadgeNFTMetadata` (`hooks/useBadges.ts:5-10`) is forward-looking metadata only.

| Step | Detail |
|---|---|
| Constants | `TREASURY_WALLET = EyEohuV8fBXyNDZK9ZtYFNe6A6FfUw9ndSwBbtNqTxmJ` (`:22`), `MINT_FEE_LAMPORTS = 1_000_000` (0.001 SOL, `:23`) |
| Connection | `new Connection(clusterApiUrl('mainnet-beta'), 'confirmed')` (`:78`) |
| Build | `getLatestBlockhash()`, `tx.feePayer = publicKey`, one `SystemProgram.transfer` instruction (`:83-91`). No memo instruction (unlike the challenge paths). |
| Sign & send | inside `authorizeAndSign`, `wallet.signAndSendTransactions({ transactions: [tx] })` (`:94-96`), `txSignature = signatures[0]` (`:99`). The signature is not confirmed on-chain afterwards. |
| On success | `users/{addr}/badges/{badgeId}` ← `{ mintedAt, txSignature }` merge (`:108-112`); when `pts > 0`, `users/{addr}.points = increment(pts)` (`:117`) and a `points_history` doc (`:118-121`). `increment` / `addDoc` / `collection` are pulled through inline dynamic `await import('@react-native-firebase/firestore')`. |
| Errors | user cancellation swallowed by matching `'CancellationException'` / `'cancelled'`; otherwise `Alert.alert('Claim Failed', …)` (`:126-134`) |
| UI guard | the mint button is hidden once `b.mintedAt` is set (`:237`) |

The same treasury address is duplicated as a constant in `hooks/useClaimChallengeReward.ts:40-42`.

---

## 5. SKR staking verification

All of it lives in `hooks/useSkrStaking.ts`. The hook answers one question: does this wallet have **≥ 1 SKR staked**.

### Accounts (`:11-13`)

| Constant | Address |
|---|---|
| `STAKING_PROGRAM` | `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ` |
| `STAKE_CONFIG` | `4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw` |
| `GUARDIAN_POOL` | `DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr` |

### Derivation and math

- PDA: `findProgramAddressSync(['user_stake', STAKE_CONFIG, user, GUARDIAN_POOL], STAKING_PROGRAM)` (`:32-43`).
  Detection is one derivation plus two `getAccountInfo` calls — no transaction-history scan, no
  `getProgramAccounts`.
- Offsets (`:15-23`), both layouts including the 8-byte Anchor discriminator:
  `USERSTAKE_SHARES_OFFSET = 105` (`8+1+32+32+32`), `STAKECONFIG_SHARE_PRICE_OFFSET = 137` (`8+1+32+32+32+8+8+16`).
- `UserStake` must be **exactly 169 bytes** (`:71`); a missing or wrong-sized account yields
  `stakedAmount 0, isStaker false` (`:71-75`). A missing config returns early, leaving prior state (`:76-79`).
- Both `shares` and `share_price` are `u128`, read as `lo + (hi << 64)` BigInts by `readU128LE` (`:26-30`).
- `rawTokens = shares * sharePrice / SHARE_PRICE_SCALE` where `SHARE_PRICE_SCALE = 1e9`; SKR has 6 decimals
  (`SKR_DECIMALS_POW = 1e6`); result rounded to 2 dp; `isStaker = rounded >= 1` (`:83-88`).
- Fetch: `new Connection(RPC_URL, 'confirmed')` then `Promise.all([getAccountInfo(pda), getAccountInfo(STAKE_CONFIG)])` (`:61-68`).

This is tightly coupled to the SKR program's account layout and will break silently if that layout changes. The
IDL the offsets came from is mirrored in `program/idl.json` of the official
`solana-mobile/react-native-samples/skr-staking` sample.

### RPC selection (`:6-9`)

`EXPO_PUBLIC_HELIUS_API_KEY` is optional. When set, the hook uses the Helius mainnet endpoint; otherwise it falls
back to `https://api.mainnet-beta.solana.com`. This key gates **only** this staking read — all three transaction
paths (§2, §4) build their own `Connection` against the public endpoint.

### Consumption and caching

- `app/(tabs)/badges.tsx:32` consumes `isStaker`, and `:34-44` auto-writes `users/{addr}/badges/skr_staker` with
  `{ earned: true, earnedAt }`. The badge is "SKR Staker", `pts: 2000`, Legendary (`hooks/useBadges.ts:77`).
- `stakedAmount` and `loading` are returned but currently unused by any screen.
- **No caching**: the check re-runs whenever `address` changes (`:107-111`) — no TTL, no Firestore cache read.
- The `finally` block (`:94-104`) best-effort `deleteDoc`s the legacy `users/{addr}/cache/skr_staking` document
  to drain data left by the pre-PDA implementation, wrapped in its own try/catch so a missing doc or a rules
  denial is silent.

### Not present

There is **no SPL token balance check anywhere in the app** — no `getTokenAccountsByOwner`,
`getParsedTokenAccountsByOwner`, `getTokenAccountBalance`, `getAssociatedTokenAddress`, and no `@solana/spl-token`
import in `app/`, `hooks/`, `components/`, `context/`, or `constants/`. A wallet holding SKR without staking it
reads as `isStaker: false`.

---

## 6. MWA transaction signing

Everything routes through `context/WalletContext.tsx` (274 lines), mounted at `app/_layout.tsx:10`. It uses
`transact()` from `@solana-mobile/mobile-wallet-adapter-protocol-web3js` (`:3`) against cluster
**`mainnet-beta`** (`:192`, `:240`), with identity `KINLOG_IDENTITY` (`:32-36`).

### Session caching

- Persisted in `expo-secure-store` under `kinlog.wallet.session` (`:31`), shape
  `{ address: string /* base58 */, authToken: string }` (`:38-41`); helpers `loadSession` (`:43-51`),
  `saveSession` (`:53-59`), `clearSession` (`:61-65`).
- The live token is held in a ref, `authTokenRef` (`:159`), so signing does not re-prompt.
- Cold start (`:165-184`) reads the cached session and sets `publicKey` + `authTokenRef` optimistically, and
  deliberately does **not** call `transact()`/reauthorize, so the wallet app is not woken on launch. An invalid
  cached address triggers `clearSession()`. `restoring` gates Connect prompts.

### Address decoding

MWA returns the account address as **base64 bytes**, not base58 (`:197-199`, identically `:247-249`):

```ts
const addressBytes = Buffer.from(account.address, 'base64');
const pk = new PublicKey(addressBytes);
```

`global.Buffer` is polyfilled in `app/_layout.tsx:1-3`. The resulting **base58 string is the Firestore user
document id throughout the app** — never substitute a different identifier.

### The signing entry point — `authorizeAndSign` (`:219-259`)

Inside a single `transact` session: if a cached token exists, `wallet.reauthorize({ auth_token, identity })`
(`:225-228`); if that fails (revoked, expired, wallet reinstalled), it logs and falls through to a fresh
`wallet.authorize({ cluster: 'mainnet-beta', identity })` **in the same session** (`:229-242`). A fresh
authorization updates `publicKey`, re-runs `initUserInFirestore`, and re-saves the session, which is what handles
account switching (`:245-255`). Finally it invokes `await callback(wallet, authToken!)` (`:257`).

Only **`signAndSendTransactions`** is ever used — `signTransactions` and `signMessages` appear nowhere. All three
call sites pass `Transaction` objects and take `signatures[0]`:

| Call site | Transaction |
|---|---|
| `app/(tabs)/badges.tsx:94-99` | SOL transfer (badge mint fee) |
| `hooks/useStartChallenge.ts:120-123` | Memo only (quest start) |
| `hooks/useClaimChallengeReward.ts:123-126` | SOL transfer + Memo (quest claim) |

`connect()` (`:186-211`) authorizes, stores the token, calls `initUserInFirestore(address)`, and saves the
session; errors are logged, never thrown (`:206-208`). `disconnect()` (`:213-217`) is **local only** — it clears
state and storage; `wallet.deauthorize()` is never called anywhere in the repo.

### Context API — `WalletContextType` (`:8-19`)

| Member | Type | Notes |
|---|---|---|
| `publicKey` | `PublicKey \| null` | decoded from the base64 MWA address |
| `shortAddress` | `string \| null` | `4 chars…4 chars` (`:261-263`) |
| `connecting` | `boolean` | true during `connect()` |
| `restoring` | `boolean` | true during the cold-start cache read |
| `connect` | `() => Promise<void>` | |
| `disconnect` | `() => void` | local only, no deauthorize |
| `authorizeAndSign` | `(cb: (wallet: any, authToken: string) => Promise<void>) => Promise<void>` | `wallet` is untyped |

### Consumers of `useWallet()`

| File:line | Uses |
|---|---|
| `app/(tabs)/index.tsx:48` | `publicKey, shortAddress, connecting, restoring, connect, disconnect` |
| `app/(tabs)/profile.tsx:25` | `publicKey, shortAddress, connecting, restoring, connect, disconnect` |
| `app/(tabs)/badges.tsx:26` | `publicKey, shortAddress, connecting, connect, disconnect, authorizeAndSign` |
| `app/(tabs)/goals.tsx:15` | `publicKey` |
| `app/(tabs)/workout.tsx:196` | `publicKey` |
| `app/challenges/index.tsx:27` | `publicKey, connecting, connect` |
| `app/challenges/[id].tsx:65` | `publicKey, connecting, connect` |
| `hooks/useStartChallenge.ts:40` | `publicKey, authorizeAndSign` |
| `hooks/useClaimChallengeReward.ts:48` | `publicKey, authorizeAndSign` |

All nine import from `context/WalletContext`. Note that `hooks/useWallet.ts` is a **stale duplicate** with no
provider, no token caching, and a leftover identity from another project; it has zero importers. Do not wire it up.

### `Connection` construction

Each is created inline per operation; there is no shared singleton.

| File:line | Endpoint |
|---|---|
| `hooks/useSkrStaking.ts:61` | Helius when `EXPO_PUBLIC_HELIUS_API_KEY` is set, else public mainnet (`:6-9`) |
| `app/(tabs)/badges.tsx:78` | `clusterApiUrl('mainnet-beta')` |
| `hooks/useStartChallenge.ts:103-106` | `clusterApiUrl('mainnet-beta')` |
| `hooks/useClaimChallengeReward.ts:99-102` | `clusterApiUrl('mainnet-beta')` |

In the three transaction paths the connection is used only for `getLatestBlockhash()`; none of them confirms the
signature after `signAndSendTransactions`.

---

## 7. License layout

| Path | Content |
|---|---|
| `LICENSE` | **MIT License**, "Copyright (c) 2026 Jamielim". The only standalone license file in the repo outside `node_modules`. |
| `package.json` | `"private": true`, and **no `license` field**. |
| `app.json` | No license field. |
| `README.md` | MIT shield badge → `LICENSE` (`:6`); "**License** \| MIT" table row (`:23`); `:138`; `:249`; "## License — MIT © 2026 Jamielim." (`:310-312`). |
| `docs/index.html:277` | Footer, "© 2026 Kinlog. MIT Licensed." |
| `docs/terms.html:216` | The **only third-party attribution in the repo**: "Kinlog uses MediaPipe (Apache 2.0 License) and other open-source libraries." |
| `TERMS_AND_CONDITIONS.md` | No license or third-party section — the HTML version has one, the Markdown version does not. |
| `PRIVACY_POLICY.md`, `docs/privacy-policy.html` | No license text. |
| `android/app/src/main/assets/pose_landmarker_lite.task` | MediaPipe Pose Landmarker Lite model (~5.8 MB), shipped with no accompanying model card or license file. Gradle dep `com.google.mediapipe:tasks-vision:0.10.14` (`android/app/build.gradle:183`). |
| `assets/images/`, `assets/screenshots/` | No license files. |

No `NOTICE`, `COPYING`, `THIRD_PARTY_LICENSES`, or `licenses/` directory exists anywhere outside `node_modules`.

---

## Appendix A: Squat criteria comparison

Target criteria under consideration, against what the code does today.

| Item | Target criterion | Current implementation | Difference |
|---|---|---|---|
| Down | Knee ≤ 110° **and** hip descent ≥ 20% of torso length (both required) | `kneeAngle < 110` alone — `workout.tsx:259` | **No hip-descent condition.** Knee angle is the only signal. Boundary is `<`, not `≤`. |
| Up | Knee ≥ 160° | `> 150` in side mode, `> 160` in front mode — `workout.tsx:261` | **The default mode (side) uses 150°**, 10° below target. Boundary is `>`, not `≥`. |
| One rep | Returning from down to up | Same — `workout.tsx:261-263` | Matches. |
| Torso length | Distance from shoulder to hip on the same side | Not computed. The native module returns **only landmarks 23–28** — `PoseLandmarkerModule.kt:77-83` | Shoulders (11/12) are not returned, so this requires a **native module change**, not a JS-only change. |
| Baseline | Refreshed while standing, frozen during descent; no baseline ⇒ no counting | None. `setAngle(180)` (`:278`, `:287`) is UI initialization, not a reference pose. | Entirely new. Requires per-frame standing detection plus a hold/freeze rule. |
| Smoothing | EMA 0.4 | None — the raw per-frame angle drives the comparison. | Entirely new. |
| Transition confirmation | 3 consecutive frames | None — a single frame crossing a threshold flips the phase and counts the rep immediately. | Entirely new. One noisy frame currently produces one phantom rep. |
| Capture | Side view | `side` / `front` toggle, default `side` (`:181`). The physical camera is always the front-facing selfie camera (`:180`). | Decide whether front mode is removed or kept. |
| Daily target | 30 reps | `TARGET = 30` (`:20`) | Matches. |

Two implementation notes for the differing rows:

- **Frame cadence.** The loop ticks every 100 ms (`:271`), so three consecutive frames is nominally ~300 ms, but
  snapshot capture plus inference latency means the effective interval is longer and irregular. A frame-count
  rule and a wall-clock rule are not interchangeable here.
- **Coordinate space.** Landmarks are normalized to the image and `z` is hard-coded to `0.0`
  (`PoseLandmarkerModule.kt:69`), with `y` increasing downward. Hip descent is therefore a `hip.y` increase in
  normalized units, and must be scaled by a torso length measured in the same units to be
  distance-from-camera independent.
