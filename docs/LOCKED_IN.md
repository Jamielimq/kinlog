# Locked In

Design reference for **Locked In**, the deposit-backed version of the 3-Day (and later 7-Day) Challenge.
Built for the Radiants CLOCK IN hackathon (Solana Mobile). This document describes the design being
implemented on branch `feat/locked-in`; sections are marked **(planned)** until the code lands.

Companion documents: `CLAUDE.md` (working rules, settled product decisions), `docs/ARCHITECTURE.md`
(current-state map of the existing app).

> Lock in 100 SKR. You get 100% back, pass or fail. Finish all 3 days for bonus ORE.

| Section | Topic |
|---|---|
| [1. Rules](#1-rules) | What a participant sees and agrees to |
| [2. Rewards](#2-rewards) | Tiers, odds, per-challenge caps, amount rule |
| [3. Cohorts](#3-cohorts) | Schedule, day boundary, joining window, deadlines |
| [4. On-chain program](#4-on-chain-program-planned) | Accounts, instructions, invariants |
| [5. Reading ORE rounds](#5-reading-ore-rounds) | Board/Round layout, target round, settlement |
| [6. Keys and blast radius](#6-keys-and-blast-radius) | Roles, what each key can and cannot do |
| [7. Server](#7-server-planned) | Cloud Functions, Firestore collections, alerts |
| [8. App](#8-app-planned) | Screens, copy rules, badges |
| [9. ORE staking](#9-ore-staking-optional) | Optional receive-as-stake path |
| [10. Testing](#10-testing) | Local mainnet-fork strategy and scenarios |
| [11. Deployment](#11-deployment) | Cost, upgrade authority, key custody |

---

## 1. Rules

- **Join:** deposit **100 SKR** and pay a **Fee of 0.001 SOL**, both in a single transaction.
  Joining is open before the challenge starts and during its first day only; from the second day on the
  program rejects deposits, because the success condition starts on day one.
- **Challenge:** do **30 squats every day** for 3 days (7 days for the 7-Day variant). Days are counted
  on a fixed boundary shared by every participant: **15:00 UTC**.
- **Deposit:** returned **100%, pass or fail**. It stays locked until the challenge ends. There is no
  cancel. After the end, the participant withdraws with one tap; anything not withdrawn is returned
  automatically on the 6th day after the end. The return address is fixed in the program to the
  depositor's own wallet.
- **Fee:** 0.001 SOL, non-refundable, collected by the program inside the deposit instruction. It is the
  project's revenue and is kept separate from the reward budget.
- **Reward:** finishing all days earns one pick on a 5×5 board of Squares. The pick's tier is decided by
  an ORE mining round (Section 2). Every pick wins at least a Common Square. Picking costs nothing but
  the Solana network fee.
- **Deadline:** pick and claim within **5 days after the challenge ends**. After that the reward
  expires; nothing is opened automatically.
- **Points and badges:** finishing awards completion points (3-Day +300, 7-Day +700) regardless of tier,
  and a Square badge matching the tier. Minting a badge costs the usual optional 0.001 SOL.

## 2. Rewards

### Tiers and odds

| Tier | Condition | Odds under current ORE rules |
|---|---|---|
| **Legendary Square** | the target ORE round hit the motherlode | 0.2% (1/500) |
| **Rare Square** | the picked square is that round's winning square | 4.0% (1/25, minus overlap with Legendary) |
| **Common Square** | anything else | 95.8% |

There is no losing outcome. Results come from ORE mining rounds; **if ORE changes its round rules, these
odds change with them.** The odds are shown in the app only on the Reward odds sheet (ⓘ on the join
screen).

### Per-challenge caps

At most **1 Legendary** and **3 Rare** per challenge. A pick whose tier is full is paid at the next tier
down (Legendary → Rare → Common; Common is uncapped). Caps are applied in the order picks were recorded
on-chain, which the program enforces by settling picks strictly in that order. Because of this, the
outcome does not depend on who submits the settlement transaction or when.

Caps exist because every pick targeting the same ORE round shares that round's result: without them, a
motherlode round would make every pick in it Legendary.

### Amount rule

Amounts are fixed per challenge at creation time and never change afterwards.

- **Common** = the USD value of the 0.001 SOL Fee, converted to ORE. It is computed separately from each
  price source (0.001 × SOL/USD ÷ ORE/USD), the **larger** of the two is taken, and it is rounded **up** to
  5 decimals, so Common is never worth less than the Fee by either source.
  Example (SOL $113.72, ORE $69.35): 0.001 × 113.72 / 69.35 = 0.0016398 → **0.00164 ORE**.
- **Rare** = Common × 2. **Legendary** = Common × 20. The program derives both from Common.
- Prices come from two sources, both queried by mint address with an API key: Jupiter Price API and
  CoinGecko. A rejected key or a token missing from a response counts as a failed read.
  ORE is always queried as `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp` (several unrelated tokens share
  the name).
- Safeguards: if the two sources disagree by more than 5% or either fails, the previous challenge's
  amount is reused and an alert fires; if there is no previous challenge, a configured fallback is used.
  If Legendary would exceed the on-chain `max_reward_per_box`, challenge creation stops for a human to
  review.

### Funding

The reward vault is funded from the team's marketing budget. It is not linked to Fee revenue by any rule.
Before a challenge is created the program reserves its worst case (1 Legendary + 3 Rare + 26 Common =
52 × Common) out of unreserved vault balance, so rewards already promised can always be paid.

## 3. Cohorts

A cohort is one run of the challenge with its own on-chain account.

- **Day boundary:** 00:00 KST = **15:00 UTC**, used by the on-chain cohort times, the server's daily
  totals, and the app ("Day resets at 15:00 UTC").
- **Schedule:** cohorts only run inside a calendar month (KST dates), and the program rejects a cohort
  whose end is more than 30 days after creation.
  - 3-Day: starts on the 1st, 4th, 7th, …, 28th (a start is skipped if its cohort would spill over).
  - 7-Day: starts on the 1st, 8th, 15th, 22nd.
- **Visible:** for each kind, the running cohort and the next scheduled one. Early deposits into the
  next cohort are allowed and stay locked until that cohort ends.
- **Creation:** automatic, by the server's cohort-creator key. The daily job creates the next scheduled
  cohort when the current one starts, or immediately when no scheduled cohort exists (first deployment,
  recovery after a failure).
- **Lifecycle after the end:**

| When | What happens |
|---|---|
| End | Withdraw opens. The Kinlog crank may also return deposits (emergency path). |
| End → End + 5 days | Pick a Square, see the result, claim ORE. |
| End + 5 days (6th day, 15:00 UTC) | Remaining SKR is returned; unclaimed rewards expire and their reservation is released; the SKR vault and cohort account are closed. Anyone may call these steps from this point on, so deposits come back even if Kinlog stops operating. |

- **Live cohorts:** at most 4 three-day cohorts (2 ended, 1 running, 1 scheduled) and 3 seven-day cohorts
  (1 ended, 1 running, 1 scheduled) exist at once. The program enforces these limits.
- **Test cohorts:** a cohort whose day length is shorter than 86,400 s is a test cohort. It can only be
  created while the Squads-controlled `min_day_seconds` is lowered, may start at any time, and is shown in
  the app only to a configured list of tester wallets.

## 4. On-chain program (planned)

An Anchor program. PDAs are addresses owned by the program with no private key, so only the program's
own rules can move what they hold.

### Accounts

| Account | Seeds | Purpose |
|---|---|---|
| `Config` | `["config"]` | role keys, `fee_wallet`, `fee_lamports`, limits (`max_reward_per_box`, `max_capacity` = 30, `max_live_cohorts`, `deposit_amount_max`, `min_day_seconds`), `deposits_paused`, `reserved_total`, live-cohort counters |
| `Cohort` | `["cohort", kind, id]` | immutable terms (kind, days, day length, start, end, deposit amount, Fee, Common amount, caps, `creator`) + counters + **30 participant slots** |
| SKR vault | `["skr_vault", cohort]` | SPL token account holding that cohort's deposits only |
| Reward vault | `["reward_vault"]` | ORE token account; anyone can fund it |

Participant records live **inside** the cohort account as 30 fixed slots, so participants pay no account
rent. A slot holds the user, success flag, returned flag, picked square, target round, pick sequence,
tier, amount, and claimed flag. Withdrawing or returning moves only SKR; the slot stays until the cohort
closes. Account rent is paid once by the cohort-creator wallet and returns to it when the cohort closes.

### Instructions

| Instruction | Caller | Rule |
|---|---|---|
| `init_config`, `set_roles`, `set_limits`, `set_fee_wallet`, `pause_deposits` | Squads (admin) | pausing stops new deposits only; withdraw and return keep working |
| `create_cohort` | cohort creator | within limits; 86,400 s cohorts must start at 15:00 UTC; end ≤ now + 30 days; reserves 52 × Common from unreserved vault balance |
| `deposit` | participant | before start or during day one; free slot; one slot per wallet; SKR mint hard-coded; transfers the Fee to `fee_wallet` in the same instruction |
| `withdraw` | participant | after end only |
| `return_deposit` | crank after end; anyone after end + 5 days | destination is always the depositor's SKR associated token account (created by the caller if missing) |
| `mark_success` | attester | from the start of the last day until end + 5 days; sets the success flag and nothing else |
| `pick_square` | successful participant | until end + 5 days; the program reads ORE's Board itself and records `round_id + 1` as the target |
| `settle` | anyone | takes no participant argument: it always settles the next pick in recording order. Reads ORE's Board and the pick's target Round at its exact PDA. Revealed round: tier from its result, then caps. Round **closed** after ORE moved past it: **Common** (no re-draw). Finished without entropy: refused, see `retarget`. Not revealed yet: refused. Logs round, reason (`revealed` / `round_closed`), winning square, pick, motherlode flag, tier, amount |
| `retarget` | anyone | only once ORE's board has moved past the target and that round **finished without entropy**; moves the target to the current round + 1 and keeps pick order. A closed round is not retargeted (it settles as Common), and a round not revealed yet cannot be skipped |
| `claim_reward` | participant | after settlement, until end + 5 days; ORE goes from the reward vault to the participant's ORE associated token account (created at the participant's expense if missing) |
| `close_cohort` | anyone, after end + 5 days | requires every deposit to be returned; burns any SKR dust someone sent into the vault (so a stray transfer cannot block closing); releases the unused reservation; closes the vault and cohort, rent to `creator` |

### Invariants

- **The only way ORE leaves the reward vault is `claim_reward`.** There is no admin withdrawal.
- **Deposits go only to the depositor.** No instruction takes a destination for SKR.
- **Nothing leaves an SKR vault before the cohort ends.** There is no cancel instruction.
- Cohort terms are immutable; no instruction edits them.
- Settlement is deterministic: the same on-chain inputs give the same tier regardless of caller.

## 5. Reading ORE rounds

Verified against `regolith-labs/ore` (`ore-api` 3.8.x, post-June-2026 "v4" layouts) and mainnet.

| Item | Value |
|---|---|
| ORE mining program | `oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv` (the older `mineRHF5…` is the legacy v1 program) |
| ORE mint | `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp`, 11 decimals, classic SPL Token |
| SKR mint | `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, 6 decimals, classic SPL Token |
| Board | fixed address `BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi`, 40 bytes: `round_id` @8, `start_slot` @16, `end_slot` @24 |
| Round | PDA `["round", id as u64 LE]`, 952 bytes, discriminator 109: `slot_hash` @616, `expires_at` @648, `motherlode` @656 |
| Config | `9c9X7aDRAF41faiDs94ELjT19UrGnn72wBW9hPsS4Awy`: `intermission_slots` @152, `round_slots` @160 |

- `rng` = XOR of the four little-endian `u64` words of `slot_hash` (none if all 0x00 or all 0xFF).
- Winning square = `rng % 25`. Motherlode hit = `rng.reverse_bits() % 500 == 0`.
- A round lasts `round_slots` (200) plus `intermission_slots` (40), about 96 s. Its result is written when
  anyone calls ORE's `reset` after the intermission. Round accounts can be closed about one day after they
  end. Settlement normally runs within a minute; a pick still unsettled when its round has been closed is
  paid **Common** rather than re-drawn. Re-drawing there would let someone who saw a bad result wait out a
  stalled crank (about 32 hours) and try again. Only a round that finished *without entropy* is
  retargeted, and "closed" is recognised only at the round's exact PDA and only once ORE's board has moved
  past it (the same PDA is also empty before ORE creates the round).
- Checked on mainnet 2026-09-25 (round ~417,296): Board, Config and Round sizes, discriminators and
  offsets match the table; consecutive rounds are ~241 slots apart and `expires_at` = end + 288,000 slots.
  Across all 1,199 live Round accounts the motherlode rule above flagged exactly the 3 rounds whose
  `motherlode` field is non-zero, with no false positives, which confirms the `rng` derivation.
- The program validates owner, PDA address, discriminator and length before reading a Round. It does not
  link `ore-api` (dependency conflicts with Anchor); the math is ported and tested against the original.

**Why `round_id + 1`.** A pick recorded while round N is still open could otherwise be timed against
N's result. Targeting the next round means the result is unknowable when the pick is recorded. The wait is
about 1.6–3.2 minutes. The app shows the target round number from the moment of picking.

## 6. Keys and blast radius

| Key | Custody | Can | Cannot |
|---|---|---|---|
| Admin: Squads 2-of-3 | laptop + two Seeker devices | upgrade the program, rotate keys, set limits and `fee_wallet`, pause new deposits | move deposits or reward ORE |
| Cohort creator | server secret; wallet funds cohort rent | create cohorts within limits | move funds, change limits |
| Attester | server secret | mark a participant successful | move funds, create cohorts |
| Crank | server secret; small SOL for fees | settle, retarget, return deposits, close cohorts | choose a destination, return before the end |

Worst cases:

- **SKR:** no key can send a deposit anywhere but back to its depositor. A program bug is bounded by one
  cohort's vault: 30 × 100 SKR.
- **ORE:** promised rewards never exceed the vault because of up-front reservation. A leaked attester plus
  cohort-creator key is bounded by live cohorts × 52 × Common, and still requires real deposits and Fees.
- **Upgrade authority** sits above every rule; it is held by the Squads multisig and builds are published
  as verifiable (`solana-verify`).
- **Squat counts** are reported by the app. Sign-in, server timestamps and plausibility checks limit
  tampering; what remains is bounded by the limits above.

## 7. Server (planned)

Firebase (Blaze plan) with Cloud Functions.

- **Wallet sign-in:** Sign In With Solana through MWA; a function verifies the signature and issues a
  Firebase custom token whose uid is the wallet address.
- **Functions:** `authNonce` / `authVerify`; `onWorkoutCreate` (daily totals on the 15:00 UTC boundary,
  immediate `mark_success` once every day is met, completion points); `everyMinute` (settle, retarget,
  badge readiness, stuck-pick alert); `daily` at 15:05 UTC (6th-day returns and closes, cohort creation,
  balance checks, success-rate check).
- **Firestore collections added:** `cohorts`, `config/testers`, `users/{wallet}/daily`,
  `users/{wallet}/lockedIn`, `users/{wallet}/badges/{badgeId}/grants`. Access is defined in
  `firestore.rules`; read that file for the rules themselves.
- **Alerts:** functions write structured log lines; Cloud Logging log-based alerts email the operator. No
  mail credentials are stored on the server. Conditions: reward vault below 0.7 ORE, server wallet low on
  SOL, cohort creation failure, a pick unsettled after 15 minutes, recent success rate above 85%.
- **Cost controls:** a monthly budget alert and a per-function instance cap (plus automatic billing
  shutdown if confirmed safe for stored data).

## 8. App (planned)

### Screens

Challenge card → join screen (deposit, Fee, start and end in UTC, "Your SKR stays locked until the
challenge ends.", ⓘ Reward odds) → daily progress → pick a Square (5×5, "Powered by ORE") → waiting screen
→ result → claim ("Receive to wallet") → badge ready.

Waiting screen: "Turning your reps into value", "Result from ORE round #N" with an explorer link (the ORE
Round account before settlement, our settlement transaction after), and a button-shaped countdown to the
target round's end that turns into "Reveal reward" (or "Confirming" while ORE is late). State is read back
from the cohort account, so leaving and returning restores it.

Results: Common Square "Challenge complete.", Rare Square "Your pick was the lucky one.", Legendary Square
"You found the rarest square." The amount is shown only after the result.

### Copy rules

English; no middle dots or em dashes; "Square" and "Reward", never "box"; no multipliers, jackpot wording
or dollar conversions; odds only on the Reward odds sheet.

### Badges

Six new badges: 3-Day and 7-Day × Common, Rare and Legendary Square. A badge becomes **Ready** when its
pick is settled (no deadline) and is minted by the owner for the usual optional 0.001 SOL. The legacy
3-Day Challenger and 7-Day Warrior badges are no longer issued and are shown only to holders. The badge
screen shows READY, EARNED (minted), LOCKED and TOTAL, sorts Ready first, and marks Ready items with a red
dot on the tab icon, the category menu and the READY tile.

## 9. ORE staking (optional)

If time allows: "Stake" as an alternative to "Receive to wallet", built as one transaction of
`claim_reward` + ORE's own stake `Deposit`, plus an in-app ORE panel with wallet and staked balances and
Stake / Unstake buttons. Funds move only between the user's wallet and ORE's stake program
(`stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH`, the post-June-2026 contract); Kinlog only builds the
transaction.
Stake accounts (checked on mainnet 2026-09-25, 2,244 accounts): 120 bytes, discriminator 108, PDA
`["stake", authority]`, `balance` at offset 40.

## 10. Testing

- **LiteSVM** unit tests with ORE Board/Round accounts dumped from mainnet and edited byte-wise (forced
  winning square, forced motherlode, empty entropy, closed round).
- **Surfpool** mainnet fork for end-to-end runs against the real ORE program, using account overrides and
  time travel.
- **Firebase Emulator** for security rules.
- **Device:** release APK on Seeker, with a short-day test cohort on mainnet.

Scenario coverage includes: Fee enforcement, the day-one joining window, no pre-end exit for anyone,
30-slot capacity and duplicates, success-window bounds, deadline enforcement, 6th-day return and close,
cap overflow and same-round crowding, settlement order and caller-independence, ORE delays and
`retarget`, price safeguards, fallback amounts, automatic first-cohort creation, and test-cohort
visibility.

## 11. Deployment

### Build

- **Verifiable build** (the artifact that is deployed):
  `solana-verify build --library-name locked_in --arch v3 -b solanafoundation/solana-verifiable-build:4.1.2 <abs path>/onchain`.
  Two flags are required: `--arch v3` (solana-verify defaults to v0; Anchor 1.2 targets SBPFv3, which mainnet
  enabled at epoch 993) and an explicit 4.1.x base image (the auto-selected image ships Cargo 1.84, which cannot
  parse the edition-2024 crates Anchor 1.2 pulls in). Pass an absolute mount path: with `.` the tool builds
  a broken manifest path. The build takes about 75 s after the image is cached.
- Size: 356,168 bytes (the in-container toolchain differs from a host `anchor build`, 342 KB). Program data is
  allocated with a 10% margin (`--max-len 392000`) so small fixes can be upgraded in place.
- Measured compute: deposit ~19k CU, pick ~4k, settle ~7k, claim ~38k including ORE account creation.

### Costs (mainnet rent at 5,080 lamports/byte, SIMD-0437 step 2)

| Item | SOL | Notes |
|---|---|---|
| Program data (392,000 bytes) | 1.992 | locked while the program exists |
| Deploy buffer (356,168 bytes) | 1.810 | needed during deploy, refunded at the end |
| **Needed on hand at deploy** | **~3.81** | plus a few thousand lamports of write-transaction fees |
| Config + reward vault | 0.003 | |
| Squads multisig | ~0.003 | creation fee is 0 (program config) |
| Each cohort (account + SKR vault) | 0.011 | returned to the cohort creator on close |
| A later upgrade | ~1.81 on hand | buffer rent, refunded to the spill address after the upgrade |

### Mainnet deployment (2026-09-26)

| Item | Value |
|---|---|
| Program | `9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby` |
| Verified build | OtterSec: verified, commit `4aed89d`, executable hash `e8f129bd…d457` ([status](https://verify.osec.io/status/9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby)) |
| Upgrade authority and admin | Squads v4 vault `FG32T61dtu8xZscxSSH9hh6UchJgCNBjhmU81dchPZ31`: 2-of-3, two of the three signers are Seeker phones using Seed Vault |

### Mainnet runbook

Every step that touches mainnet is run only after the owner approves that exact command. Scripts live in
`onchain/scripts` (`npx tsx li.ts <command> --cluster mainnet --confirm-mainnet ...`); every command prints the
network first, takes explicit keypair paths, and supports `--dry-run`. Rehearsed end to end on a local
Agave 4.1.2 validator with mainnet clones of the Squads program, SKR and ORE mints, and real ORE round data
(settlement read a real round and produced the tier ORE's own event records).

1. **Build and hash.** Verifiable build as above; record `solana-verify get-executable-hash`.
2. **Deploy** with the dedicated deploy key as payer and temporary upgrade authority:
   `solana program deploy <so> --url mainnet-beta --program-id <program keypair> --keypair <deploy key> --upgrade-authority <deploy key> --max-len 392000`.
   Check `solana-verify get-program-hash <program id>` equals step 1.
   *If it fails midway*: `solana program show --buffers --buffer-authority <deploy key>` then
   `solana program close --buffers --buffer-authority <deploy key> --keypair <deploy key>` recovers the buffer
   rent; re-run the deploy (or resume with `--buffer <buffer>`).
3. **Squads 2-of-3** (`squads-create`), members: laptop key, jamielim.skr, isollim.skr. Use the printed **vault**
   address, not the multisig account, for everything below.
4. **Vault check before any authority moves**: a memo proposal from the vault, approved from both signer phones
   in the Squads app, then executed. Compare the vault address shown in the app with step 3.
5. **init_config** with the deploy key (still the upgrade authority): admin = vault, roles = server keys,
   fee wallet, limits.
6. **Transfer the upgrade authority** to the vault:
   `solana program set-upgrade-authority <program id> --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check --upgrade-authority <deploy key> --keypair <deploy key> --url mainnet-beta`.
7. **Verification (OtterSec).** The verification record must be uploaded by the current upgrade authority, so
   after step 6 it goes through Squads: `solana-verify export-pda-tx <repo> --program-id <id> --uploader <vault>
   --mount-path onchain --library-name locked_in --arch v3 -b <image> --commit-hash <commit>`, propose it with
   `squads-propose --action import-tx`, approve, execute, then
   `solana-verify remote submit-job --program-id <id> --uploader <vault>`.
8. **Fund the reward vault** from the deploy wallet with a checked transfer into the vault token account
   (`fund-reward-vault`), first 0.001 ORE, then the rest.
9. **Fund server wallets** (cohort creator, crank, attester).
10. **Test cohort**: Squads lowers `min_day_seconds` to 600; the cohort creator opens a short cohort with a
    1 SKR deposit; test wallets run deposit, success, pick, settle, claim, withdraw, close; Squads restores
    `min_day_seconds` to 86,400 and the value is read back.

**Upgrading later**: `solana program write-buffer` with the deploy key, `solana program set-buffer-authority
<buffer> --new-buffer-authority <vault>`, then `squads-propose --action upgrade --buffer <buffer> --spill <deploy
wallet>`, approve, execute. Rehearsed locally.

- Server keypairs are kept outside the repository and in Secret Manager; no keypair or secret is ever
  committed.
