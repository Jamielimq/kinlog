use anchor_lang::prelude::*;

/// SKR mint (classic SPL Token, 6 decimals). Hard-coded so a look-alike token can never be deposited.
pub const SKR_MINT: Pubkey = pubkey!("SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3");
pub const SKR_DECIMALS: u8 = 6;

/// ORE mint (classic SPL Token, 11 decimals).
pub const ORE_MINT: Pubkey = pubkey!("oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp");
pub const ORE_DECIMALS: u8 = 11;
/// Reward amounts are whole multiples of 0.00001 ORE (5 decimals of 11).
pub const ORE_REWARD_GRANULARITY: u64 = 1_000_000;

/// ORE mining program (v3, post-June-2026 layouts). The legacy `mineRHF5…` program is NOT this.
pub const ORE_PROGRAM_ID: Pubkey = pubkey!("oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv");
pub const ORE_BOARD: Pubkey = pubkey!("BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi");

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const COHORT_SEED: &[u8] = b"cohort";
#[constant]
pub const SKR_VAULT_SEED: &[u8] = b"skr_vault";
#[constant]
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault";

/// Participant slots stored inside every cohort account.
pub const MAX_SLOTS: usize = 30;

pub const KIND_3_DAY: u8 = 0;
pub const KIND_7_DAY: u8 = 1;
pub const KIND_COUNT: usize = 2;

pub const SECONDS_PER_DAY: u32 = 86_400;
/// Real (86,400 s) cohorts start at 00:00 KST = 15:00 UTC.
pub const REAL_COHORT_START_OFFSET: i64 = 15 * 3_600;
/// A cohort must end within this many seconds of its creation.
pub const MAX_END_AHEAD: i64 = 30 * 86_400;
/// Picking and claiming stay open for this many cohort days after the end.
pub const CLAIM_WINDOW_DAYS: i64 = 5;

pub const LEGENDARY_CAP: u8 = 1;
pub const RARE_CAP: u8 = 3;
pub const LEGENDARY_MULTIPLIER: u64 = 20;
pub const RARE_MULTIPLIER: u64 = 2;

pub const BOARD_SQUARES: u8 = 25;
