# Security

## Reporting a vulnerability

Email **jamielimq@gmail.com**. Please do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, and what an attacker could gain.

## Scope

- The Locked In program: `9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby` on Solana mainnet (`onchain/`)
- Cloud Functions (`functions/`)
- Firestore security rules (`firestore.rules`)
- The Kinlog Android app (`app/`, `lib/`, `hooks/`, `context/`)

## Security model

See [Security model](README.md#security-model) in the README for the invariants, keys, upgrade authority, verified build and tests. The full design is in [docs/LOCKED_IN.md](docs/LOCKED_IN.md), sections 4, 6 and 7.

## Known limitations

- **Squat counts are reported by the app.** The server cannot see the camera. Counts are limited by wallet sign-in, server timestamps and per-workout limits, and a successful challenge unlocks only a free pick, never the deposit.
- **The app's Helius RPC key can be extracted from the APK.** It is a free-tier key. If it is abused, the app's reads may be rate limited. It will be rotated after the hackathon.
- **Badges are memo records.** A badge claim is a 0.001 SOL transfer with a memo. There is no on-chain badge account yet.
- **ORE rules are a copy.** The program recomputes the winning square and motherlode with ORE's round rules as of October 2026. If ORE changes them, the program keeps the old rules until it is updated.

## Out of scope

- ORE
- SKR staking
- The Squads program
- Wallet apps
