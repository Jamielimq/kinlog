# Kinlog

> **The Movement Layer for Solana.**
> AI-powered fitness dApp. Tracked by AI. Owned by you.

[![License: MIT](https://img.shields.io/badge/License-MIT-D97706.svg)](LICENSE)
![Solana dApp Store](https://img.shields.io/badge/Solana%20dApp%20Store-Live-14F195)
[![Version](https://img.shields.io/badge/version-v1.3.1-2D2926)](https://github.com/Jamielimq/kinlog/releases)
[![MONOLITH](https://img.shields.io/badge/MONOLITH-Honorable%20Mention-D97706)](https://blog.solanamobile.com)

Built by a licensed Physical Therapist & Athletic Trainer.

---

## Status

| | |
|---|---|
| **Live** | 🟢 Solana Mobile dApp Store |
| **Version** | v1.3.1 |
| **Reviews** | 22+ · ★★★★ |
| **Awards** | MONOLITH Honorable Mention (Solana Mobile, 2026) |
| **License** | MIT |
| **Platform** | Solana Mobile · Seeker · Android |

---

## Philosophy

> **As AI advances, human movement becomes more valuable.**

The more AI does for us, the less we move.

But movement is something only humans can do.

That is where Kinlog focuses.

---

## The Question That Started Everything

**What does it mean to be human in the age of AI?**

I am a physical therapist and athletic trainer. Every day, I evaluate how people move. How they act. How they function. How they live.

The population is aging faster. Desk jobs are multiplying. The average person now sits for over 10 hours a day. Everyone knows they should exercise. Most do not know if they are doing it right. And ironically, as AI gets smarter, humans have even less reason to use their bodies.

We outsource our thinking to AI. We outsource our memory to AI.

But there is one thing AI cannot do for you.

**It cannot sweat for you. It cannot endure for you. It cannot get back up for you.**

The more AI advances, the more physical movement becomes a distinctly human act. Thinking, judging, creating. AI can do those things. But the moment you decide to do one more rep when your legs are burning. The moment you stand back up. That is still yours. That will always be yours.

---

## Why Web3?

Web3 is built on ownership. You own your wallet, your assets, your history.

But what about your body?

Your fitness history belongs to a corporation. Your achievements disappear when the app does.

Kinlog puts that on chain. Your effort, permanently yours.

Every exercise you complete is recorded on Solana. Permanently. Immutably. Owned by you. Not as a number in a database. As an on-chain proof of effort. A badge that no one can take away.

**The most human thing you do deserves to be owned by you.**

This is why Web3 people should care about fitness. And why fitness people should care about Web3. Movement is the original proof of work.

---

## What is Kinlog?

Kinlog is a fitness dApp that uses AI-powered motion recognition to count squat reps in real time. No wearables. No gym equipment. Just your phone and your body.

- Complete your daily 30-squat goal
- Build streaks
- Take on 3-Day and 7-Day Challenges
- Earn badge rewards on Solana Mainnet
- SKR stakers unlock exclusive Legendary badges

Built by a licensed Physical Therapist who got tired of watching people move less and less.

---

## The Algorithm Came From the Clinic

The squat detection is not arbitrary.

MediaPipe Pose Landmarker tracks 33 joint positions in real time. Kinlog uses three: **hip, knee, ankle.**

- Below **110°** = counted as "down"
- Above **160°** = counted as "up"
- Only this sequence = 1 rep

**Why these numbers?**

Too shallow and there is no training effect. Too deep and you stress the knee cartilage. These thresholds come from years of working with athletes and patients. From a physical therapist who has watched thousands of squats.

These thresholds were set with one priority. Making movement accessible. The goal is habit formation, not perfection. Low enough to be effective. Forgiving enough to keep you coming back.

For the first time, years of clinical knowledge became a single algorithm.

---

## Features

- **AI Motion Detection** · MediaPipe Pose Landmarker, clinically calibrated squat counting
- **Real-time Angle Display** · See your knee angle live on screen
- **Daily Goals** · 30 squats per day with weekly and monthly targets
- **3-Day & 7-Day Challenges** · Streak-building mechanics for daily habits
- **Badge Rewards** · 34 badges across 4 rarity tiers, issued on Solana Mainnet
- **SKR Staker Rewards** · Exclusive Legendary badges for SKR stakers
- **Streak Tracking** · Firebase Firestore tracks your consistency
- **On-chain Records** · Every achievement permanently recorded on Solana
- **No Wearables Needed** · Just your phone camera
- **Privacy First** · All pose detection runs on device. Your camera never leaves your phone.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Mobile** | React Native (Expo bare workflow) |
| **Motion AI** | MediaPipe Pose Landmarker (native Kotlin module) |
| **Camera** | react-native-vision-camera |
| **Blockchain** | Solana Mainnet |
| **Wallet** | Solana Mobile Wallet Adapter (MWA) |
| **Badge Rewards** | Metaplex (compressed badge migration planned for Phase 4) |
| **SKR Staking** | Helius API (3-layer lookup) |
| **Backend** | Firebase Firestore |
| **Target Device** | Solana Seeker (Android) |
| **Open Source** | github.com/Jamielimq/kinlog · MIT |

**Latency**: Sub-second pose inference
**Fees**: ~0.001 SOL per badge issuance
**Privacy**: On-device inference. No video uploaded or recorded.
**Surface**: Mobile-first. On-chain.

---

## How It Works

1. Open the app and connect your Solana wallet
2. Go to the Workout screen. Position yourself so your full body is in frame
3. The AI tracks your hip, knee, and ankle in real time
4. Squat below 110° knee angle → stand above 160° → that is 1 rep
5. Hit 30 reps to complete your daily goal
6. Earn points. Build streaks. Receive badge rewards as permanent proof
7. Stake SKR to unlock Legendary badges

---

## Screenshots

### Core Experience

| Home | Squat (Start) | Squat (Complete) |
|:---:|:---:|:---:|
| <img src="assets/screenshots/1.%20Kinlog-Home.png" width="240" alt="Home" /> | <img src="assets/screenshots/9.%20Kinlog-Squat%20Start.png" width="240" alt="Squat Start" /> | <img src="assets/screenshots/10.%20Kinlog-Squat%20End.png" width="240" alt="Squat End" /> |

### Goals & Achievements

| Goals | Badges | Profile |
|:---:|:---:|:---:|
| <img src="assets/screenshots/3.%20Kinlog-Goal.png" width="240" alt="Goals" /> | <img src="assets/screenshots/2.%20Kinlog-Badge.png" width="240" alt="Badges" /> | <img src="assets/screenshots/5.%20Kinlog-Profile.png" width="240" alt="Profile" /> |

### Challenges

| Challenges | 3-Day Challenge | 7-Day Challenge |
|:---:|:---:|:---:|
| <img src="assets/screenshots/6.%20Kinlog-Challenge.png" width="240" alt="Challenges" /> | <img src="assets/screenshots/7.%20Kinlog-3days%20Challenge.png" width="240" alt="3-Day Challenge" /> | <img src="assets/screenshots/8.%20Kinlog-7days%20Challenge.png" width="240" alt="7-Day Challenge" /> |

### SKR Staker Exclusive

<p align="center">
  <img src="assets/screenshots/4.%20Kinlog-SKR%20Staking%20Badge.png" width="320" alt="SKR Legendary Badge" />
</p>

---

## Badge Rewards

34 unique badges across 4 rarity tiers.

| Tier | Examples |
|---|---|
| 🟫 **Common** | First Squat, 3-Day Streak, Daily Goal |
| 🟢 **Uncommon** | Week Warrior, 50 Squats, Consistency |
| 🔵 **Rare** | Monthly Master, 500 Squats, Iron Will |
| 🟡 **Legendary** | Centurion, Streak Legend, Elite Athlete |
| 🟠 **Legendary · SKR exclusive** | Unlocked by staking SKR. Unique to stakers only. |

Every badge is issued on Solana Mainnet. ~0.001 SOL per badge.

---

## SKR Staking Integration

Kinlog reads your SKR stake on-chain to unlock exclusive content.

- **Program**: `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ`
- **Minimum**: 1 SKR staked
- **3-layer lookup**:
  1. Firebase cache (fast path)
  2. Helius enhanced transaction history (fallback)
  3. getProgramAccounts (last resort)
- **Verification**: Real-time. No claim button. The chain is the source of truth.

If you stake, you qualify. If you do not, you do not.

---

## Roadmap

### Phase 1 · Foundation (Q4 2025 to Q2 2026) ✅
- MediaPipe pose detection
- Mobile Wallet Adapter integration
- Badge reward system
- MONOLITH Hackathon Honorable Mention

### Phase 2 · Movement Layer (Q2 2026) ✅ Live
- SKR staking integration
- 3-Day & 7-Day Challenges
- Legendary stakers-only badges
- Badge reward expansion to 34

### Phase 3 · Expansion (Q3 to Q4 2026)
- New exercises (lunge, push-up, plank)
- Group challenges & leaderboards
- Premium tier with activity rewards
- Strategic partnerships

### Phase 4 · Vision (2027+)
- Compressed badge migration · Metaplex Bubblegum
- iOS & Google Play launch
- AI coaching
- Movement Layer SDK for Solana health dApps

---

## Open Source & Composability

Kinlog is MIT licensed. Built to compose with other Solana primitives.

- **Today** · SKR staking verification, on-chain workout records, MWA integration
- **Tomorrow** · Movement Layer SDK so other Solana dApps can read verified human movement

Workout data lives on Solana. Public. Verifiable. Composable.

---

## Solana Ecosystem Contribution

- A new dApp category. The Movement Layer.
- SKR token integration. Solana Mobile native.
- All workouts on-chain. Public. Verifiable.
- Microtransaction model for fitness rewards.
- Mobile-first Solana adoption (Seeker).

---

## Privacy & Legal

- [Privacy Policy](https://jamielimq.github.io/kinlog/privacy-policy.html)
- [Terms of Service](https://jamielimq.github.io/kinlog/terms.html)

All pose detection runs on device. Camera frames are never uploaded. No video is recorded or saved.

---

## The Build

This app was built by a Physical Therapist with the help of AI (Claude). The gap between knowledge and creation closed. What mattered was having something worth building.

Movement is the most honest thing a person can do. You cannot fake exercise. You cannot cheat a streak. The body does not lie.

Kinlog exists because the world is better when people move. When habits are formed. When effort is owned.

---

## Builder

**Jamielim** · Physical Therapist · Athletic Trainer

A working clinician shipping on Solana Mobile.

- **CLINICAL** · Daily PT and AT practice
- **INSIGHT** · Sees patients struggle with movement habits every day
- **FIT** · Built from clinical observation, not assumption
- **SHIPPING** · Already live on the Solana Mobile dApp Store

> "I treat people in pain every day. Most pain comes from not moving enough. But people cannot build the daily habit. So I built Kinlog."

---

## Links

- [Website](https://jamielimq.github.io/kinlog/)
- [GitHub](https://github.com/Jamielimq/kinlog)
- [X (Twitter)](https://x.com/CryptoJHLim)

---

## License

MIT © 2026 Jamielim. See [LICENSE](LICENSE) for details.

---

**Movement has Kinlog.** The Movement Layer.
