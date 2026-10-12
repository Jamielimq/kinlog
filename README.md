# Kinlog

> **Proof of Squat.** The Movement Layer for Solana. An AI pose detection fitness dApp on Solana Mobile, built by a physical therapist.

[![License: MIT](https://img.shields.io/badge/License-MIT-D97706.svg)](LICENSE)
![Solana dApp Store](https://img.shields.io/badge/Solana%20dApp%20Store-Live-14F195)
[![Version](https://img.shields.io/badge/version-v1.4.0-2D2926)](https://github.com/Jamielimq/kinlog/releases)
[![MONOLITH](https://img.shields.io/badge/MONOLITH-Honorable%20Mention-D97706)](https://blog.solanamobile.com)

---

## Status (Oct 2026)

| | |
|---|---|
| **Users** | 1,329 |
| **Reviews** | 255 (4.1 average) |
| **Squats counted** | 53,320 |
| **Retention** | 49% of active users came back on 3 or more days |
| **Version** | 1.4.0, live on the Solana dApp Store since Oct 10, 2026 |
| **Award** | MONOLITH Honorable Mention (Solana Mobile, 2026) |

---

## Built during CLOCK IN

**Locked In Challenge.** Lock 100 SKR and squat 3 or 7 days. Your SKR: 100% back, pass or fail. Finish every day for bonus ORE, with the tier set by an ORE round. Live on mainnet, with a 2-of-3 multisig and a verified build.

**AI pose detection, upgraded.** Only real squats count: a hip check and bad-frame rejection, tested on a Seeker.

**Monthly badges.** Nine badges that reset every month, from your first day to a full month, so there is always a next goal. Every claim is written on Solana.

**Also new:** Sign in with Solana on kinlog.app, and workouts saved only under your wallet sign-in.

---

## Philosophy

As AI advances, human movement becomes more valuable. The more AI does for us, the less we move.

---

## Why Solana

Solana has Proof of History. Kinlog adds Proof of Squat. Daily habits need daily transactions. Solana makes them cheap and fast.

| | |
|---|---|
| **Proof of Squat** | AI pose detection counts real squats on the phone. Finished challenges go on-chain. |
| **Mobile Wallet Adapter + Seed Vault** | Every deposit, pick, claim and badge is signed on the phone. |
| **Sign In With Solana** | Workouts save only under your wallet sign-in, on kinlog.app. |
| **SKR** | Stake SKR, earn a badge. Lock SKR, build a habit. |
| **ORE** | ORE rounds decide the tier. Rewards are paid in ORE. |
| **Squads on Seeker** | Upgrades need 2 of 3 keys. Each key is on its own device, 2 of them Seeker phones. |

RPC: Helius in the app, Alchemy on the server.

Workout records live in Firebase. What goes on Solana is the badge claim transaction and everything in Locked In.

---

## How it works

1. Connect a wallet through Mobile Wallet Adapter. On a Seeker that is Seed Vault.
2. Sign in with Solana once. Workouts are saved under that wallet.
3. Stand side-on to the camera and squat. Counting runs on the phone.
4. Reach 30 squats a day. Earn points, build a streak, unlock badges.
5. Claim a badge: 0.001 SOL and a memo naming the badge, signed in your wallet.
6. Join Locked In: lock 100 SKR, squat every day, pick a Square, claim ORE, get your SKR back.

---

## Locked In Challenge

Full design: [docs/LOCKED_IN.md](docs/LOCKED_IN.md).

**Rules**

- Join with **100 SKR** and a **Fee of 0.001 SOL** in one transaction. The Fee is project revenue and is not refunded.
- Joining is open before the challenge starts and during its first day only.
- Do **30 squats every day** for 3 or 7 days. Every participant shares one day boundary: 15:00 UTC.
- The deposit is returned **100%, pass or fail**. It stays locked until the end. There is no cancel.
- Finish every day and you get one pick on a 5×5 board of Squares. Picking is free apart from the network fee. Every pick wins at least a Common Square.

**Tiers**

| Tier | Comes from | Odds under ORE's October 2026 rules |
|---|---|---|
| Legendary Square | the target ORE round hit the motherlode | 1 in 500 |
| Rare Square | your Square is that round's winning square | 1 in 25 |
| Common Square | anything else | the rest |

At most **1 Legendary** and **3 Rare** per cohort. A pick whose tier is full is paid one tier down. Picks are settled strictly in the order they were recorded, so the result does not depend on who sends the settlement or when. Reward amounts are fixed when a cohort is created.

**Why the next ORE round.** A pick targets the round after the one that is open when it is recorded (`round_id + 1`). Its result cannot be known at pick time, so nobody can time a pick against a round they can already see. The wait is about 1.6 to 3.2 minutes.

**Deadlines.** Pick and claim within 5 days after the challenge ends. On the 6th day at 15:00 UTC, any SKR not yet withdrawn is returned automatically and unclaimed rewards expire. From then on anyone can call the return, so deposits come back even if Kinlog stops operating.

---

## Security model

Program: [`9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby`](https://solscan.io/account/9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby) (Anchor, Solana mainnet). Details: [docs/LOCKED_IN.md](docs/LOCKED_IN.md) sections 4, 6 and 7. To report a vulnerability, see [SECURITY.md](SECURITY.md).

### Invariants

1. **The only way ORE leaves the reward vault is `claim_reward`.** There is no admin withdrawal.
2. **Deposits go only to the depositor.** No instruction takes a destination for SKR.
3. **Nothing leaves an SKR vault before the cohort ends.** There is no cancel instruction.

Deposits and rewards sit in PDAs, which have no private key. Only the program's rules can move them. Before a cohort is created, the program reserves its worst case reward out of unreserved vault balance, so promised rewards never exceed the vault.

### Keys

| Key | Custody | Can | Cannot |
|---|---|---|---|
| Admin: Squads 2-of-3 | laptop + two Seeker devices | upgrade the program, rotate keys, set limits and `fee_wallet`, pause new deposits | move deposits or reward ORE |
| Cohort creator | server secret; wallet funds cohort rent | create cohorts within limits | move funds, change limits |
| Attester | server secret | mark a participant successful | move funds, create cohorts |
| Crank | server secret; small SOL for fees | settle, retarget, return deposits, close cohorts | choose a destination, return before the end |

Worst cases, from [docs/LOCKED_IN.md](docs/LOCKED_IN.md) section 6:

- **SKR.** No key can send a deposit anywhere but back to its depositor. A program bug is bounded by one cohort's vault: 30 × 100 SKR.
- **ORE.** A leaked attester plus cohort creator key is bounded by live cohorts × 52 × Common, and still needs real deposits and Fees.
- **Pausing** stops new deposits only. Withdraw and return keep working.

### Upgrade authority

The upgrade authority and admin is the Squads v4 vault `FG32T61dtu8xZscxSSH9hh6UchJgCNBjhmU81dchPZ31`, 2-of-3. Two of the three signers are Seeker phones using Seed Vault. An upgrade is a Squads proposal that two signers approve.

### Verified build

Verified by OtterSec at commit `4aed89d`: [verify.osec.io status](https://verify.osec.io/status/9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby). The build command and image are in [docs/LOCKED_IN.md](docs/LOCKED_IN.md) section 11.

### Tests

**Program: 38 tests** in `onchain/programs/locked_in/tests`, run on LiteSVM against the built program with ORE Board and Round accounts dumped from mainnet.

| File | Tests | Covers |
|---|---|---|
| `flow.rs` | 8 | the full lifecycle, mainnet rounds settling to the expected tiers, caps in pick order, caller independence, retarget and closed rounds, return and close |
| `guards.rs` | 26 | who may call what, and when |
| `ore_math.rs` | 4 | winning square and motherlode math against ORE's rules |

Guards that map directly to the invariants, by name:

- `skr_goes_only_to_the_depositor`
- `nobody_gets_skr_out_before_the_end`
- `instruction_set_has_no_cancel_or_admin_withdrawal`
- `only_the_crank_returns_between_end_and_deadline`

**Server: 35 unit tests** in `functions/test/unit` (sign-in, log redaction, ORE round reading, prices, program layout and PDAs, cohort schedule, the genesis check and RPC fallback).

**Emulator: 29 tests** in `functions/test/emulator`: 9 for Firestore rules and 20 for the server functions (sign-in, attestation, the every-minute crank, the daily job).

### Server protections

- **Genesis check before any transaction.** Each instance checks its RPC's genesis hash. On another cluster, every transaction is refused. ([functions/src/chain/solana.ts](functions/src/chain/solana.ts))
- **Server transactions never fall back to a public RPC.** Reads may fall back; transactions only go through the primary RPC.
- **Keys are masked in logs.** Registered secret values and API-key-shaped strings are replaced before anything is written. ([functions/src/log.ts](functions/src/log.ts))
- **Off by default.** Every server switch lives in `config/ops`. Without that document nothing is sent.
- Server keypairs are kept outside the repository, in Secret Manager. No keypair or secret is committed.

### Trust assumptions

- **Squat counts are reported by the app.** The server cannot see the camera.
- That count is limited by wallet sign-in (a workout counts only under the signed-in wallet), server timestamps (days are counted by Firestore's create time, not the phone's clock) and per-workout limits. See `firestore.rules` and [functions/src/workout/attest.ts](functions/src/workout/attest.ts).
- What remains is bounded by the key limits above: success unlocks one free pick, never the deposit.

---

## AI pose detection (1.4.0)

MediaPipe Pose Landmarker runs in a native Kotlin module on the phone. Kinlog uses the hip, knee, ankle and shoulder. Side view only. Full reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) section 1.

- **Down** when the knee is at **110° or less** and the hip has dropped by at least **20% of torso length** below the standing position.
- **Up, one rep,** when the knee is back at **150° or more**.
- **Why the hip check.** Knee angle alone cannot tell a squat from a standing knee raise. Lifting one foot bends that knee past 110°.
- **Bad frames are dropped.** A frame is excluded if any joint of the measured leg has confidence below **0.5**, or if the joints are in an impossible order (shoulder below hip, hip or knee below ankle).
- **No smoothing.** At the frame rate the phone reaches, filters made counting worse. An average shrank real swings so the 150° line was barely reachable. A median and multi-frame confirmation dropped the one-frame top of fast reps. Each frame is judged on its own.

The 110° and 150° thresholds come from physical therapy practice.

**Measured on device** (Seeker, release build, [ARCHITECTURE.md](docs/ARCHITECTURE.md#measured-on-device)): about 4.2 frames a second, and 95% of frames used for judgement.

Final test on a Seeker: 10 of 10 fast reps and 10 of 10 slow reps counted. Shallow squats and standing knee raises: 0 counted.

---

## Badges

| Kind | Count | How it is earned |
|---|---|---|
| **Lifetime** | 34 in the catalog | squat totals (14), streaks (14), special (4, including SKR Staker), and 2 legacy quest badges shown only to wallets that hold them |
| **Monthly** | 9 each month | daily goal days in a row inside a calendar month, from 1 day to every day of the month |
| **Square** | 6 | a Locked In pick: 3-Day and 7-Day, each Common, Rare or Legendary |

Rarity tiers: Common, Uncommon, Rare, Epic, Legendary (5). Two special badges, Perfect Week and Perfect Month, are not awarded yet.

**Claiming** works the same for every kind:

1. One transaction: 0.001 SOL claim fee to the Kinlog treasury plus a memo naming the badge. It is simulated before the wallet opens.
2. The transaction ID is stored on the phone the moment the wallet sends it.
3. Only after Solana confirms it is the badge recorded, together with its points. A failed claim is dropped.
4. Because the transaction ID is kept, a retry checks the same transaction instead of paying again.

The memo is the record for now. There is no on-chain badge account yet.

---

## Tech stack

| Layer | Technology |
|---|---|
| App | React Native, Expo bare workflow, expo-router |
| Pose detection | MediaPipe Pose Landmarker in a native Kotlin module, react-native-vision-camera |
| App RPC | Helius |
| Server RPC | Alchemy |
| Backend | Firebase: Firestore, Cloud Functions v2 |
| On-chain program | Anchor (Locked In) |
| Admin | Squads v4 multisig |
| Rewards | ORE |
| Deposits and staking | SKR |
| Wallet | Mobile Wallet Adapter + Seed Vault |
| Sign-in | Sign In With Solana |
| Target device | Solana Seeker (Android) |

---

## Repository map

| Path | What is there |
|---|---|
| `app/` | Screens (expo-router): the five tabs, Locked In join and Square screens, legacy quest screens |
| `lib/` | Shared Solana connection, badge claims and pending claims, wallet sign-in, Locked In client (`lib/lockedIn`) |
| `hooks/` | Live Firestore and chain reads, the pose detection bridge |
| `context/` | `WalletContext` (Mobile Wallet Adapter, sign-in) and `ClaimsContext` (badge claims) |
| `functions/` | Cloud Functions v2: wallet sign-in, workout attestation, the every-minute crank, the daily job |
| `onchain/` | Anchor program `locked_in`, its LiteSVM tests, mainnet scripts |
| `docs/` | [ARCHITECTURE.md](docs/ARCHITECTURE.md), [LOCKED_IN.md](docs/LOCKED_IN.md), and the kinlog.app site |

---

## Run the tests

```bash
npm run lint                            # app lint
npm --prefix functions run typecheck    # server tsc
npm --prefix functions test             # server unit tests
firebase emulators:exec --only firestore,auth --project demo-kinlog "npm --prefix functions run test:emulator"   # rules and server

cd onchain && anchor build && cargo test   # program tests (they load target/deploy/locked_in.so)
```

The app itself has no test runner. Pose detection needs the native Android module and a camera.

---

## Screenshots (v1.3.3)

| Home | Squat (Start) | Squat (Complete) |
|:---:|:---:|:---:|
| <img src="assets/screenshots/1.%20Kinlog-Home.png" width="240" alt="Home" /> | <img src="assets/screenshots/9.%20Kinlog-Squat%20Start.png" width="240" alt="Squat Start" /> | <img src="assets/screenshots/10.%20Kinlog-Squat%20End.png" width="240" alt="Squat End" /> |

| Goals | Badges | Profile |
|:---:|:---:|:---:|
| <img src="assets/screenshots/3.%20Kinlog-Goal.png" width="240" alt="Goals" /> | <img src="assets/screenshots/2.%20Kinlog-Badge.png" width="240" alt="Badges" /> | <img src="assets/screenshots/5.%20Kinlog-Profile.png" width="240" alt="Profile" /> |

<p align="center">
  <img src="assets/screenshots/4.%20Kinlog-SKR%20Staking%20Badge.png" width="320" alt="SKR Staker badge" />
</p>

---

## Privacy

- Squat judgement happens only on the phone.
- Each camera frame is written to the app's cache, used once, and deleted right away.
- No video is recorded or saved. No frame is uploaded.
- [Privacy Policy](https://kinlog.app/privacy-policy.html) and [Terms](https://kinlog.app/terms.html).

---

## Roadmap

**Phase 1: Done**
- MediaPipe pose detection
- Mobile Wallet Adapter
- Badge reward system
- MONOLITH Hackathon Honorable Mention

**Phase 2: Done**
- Challenge mode (3 and 7 days)
- SKR Staker badge
- Frontier Hackathon submission
- Solana Mobile Builder Grant submission

**Phase 3: CLOCK IN**
- Locked In Challenge with SKR and ORE
- Monthly badges
- AI pose detection upgrade
- Squads multisig 2 of 3
- Verified build

**Phase 4: Next**
- Lunge detection
- Single-leg balance
- Leaderboard

---

## Builder

**Jamie Lim.** Physical Therapist, Athletic Trainer, NSCA-CSCS.

- In clinical practice since 2019.
- MONOLITH Honorable Mention.
- Superteam Korea member.

This app was built by a Physical Therapist with the help of AI (Claude). The gap between knowledge and creation closed. What mattered was having something worth building.

---

## Links

- [Website](https://kinlog.app/)
- [GitHub](https://github.com/Jamielimq/kinlog)
- [Program (Solscan)](https://solscan.io/account/9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby)
- [Verified build](https://verify.osec.io/status/9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby)
- [APK (v1.4.0)](https://github.com/Jamielimq/kinlog/releases/download/v1.4.0/kinlog-1.4.0-release-a1eea13.apk)
- X: [@kinlogfit](https://x.com/kinlogfit) (official)
- X: [@CryptoJHLim](https://x.com/CryptoJHLim) (founder)
- Contact: jamielimq@gmail.com

---

## License

MIT. See [LICENSE](LICENSE).
