use anchor_lang::prelude::*;

use crate::constants::*;
use crate::error::LockedInError;

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Squads vault. Upgrades, role rotation, limits, fee wallet, deposit pause.
    pub admin: Pubkey,
    /// Server key that creates cohorts within the limits below and pays their rent.
    pub cohort_creator: Pubkey,
    /// Server key that can only mark a participant successful.
    pub attester: Pubkey,
    /// Server key that returns deposits after the end (anyone may after the deadline).
    pub crank: Pubkey,
    /// Receives the non-refundable joining Fee.
    pub fee_wallet: Pubkey,
    pub fee_lamports: u64,
    pub deposit_amount_max: u64,
    pub max_reward_per_box: u64,
    /// ORE promised to live cohorts and not yet claimed. Never exceeds the reward vault balance.
    pub reserved_total: u64,
    pub min_day_seconds: u32,
    pub max_capacity: u8,
    pub max_live_cohorts: [u8; KIND_COUNT],
    pub live_cohorts: [u8; KIND_COUNT],
    pub deposits_paused: bool,
    pub bump: u8,
    pub reward_vault_bump: u8,
}

pub const FLAG_OCCUPIED: u8 = 1 << 0;
pub const FLAG_SUCCESS: u8 = 1 << 1;
pub const FLAG_RETURNED: u8 = 1 << 2;
pub const FLAG_PICKED: u8 = 1 << 3;
pub const FLAG_SETTLED: u8 = 1 << 4;
pub const FLAG_CLAIMED: u8 = 1 << 5;

pub const TIER_NONE: u8 = 0;
pub const TIER_COMMON: u8 = 1;
pub const TIER_RARE: u8 = 2;
pub const TIER_LEGENDARY: u8 = 3;

#[zero_copy]
#[derive(Default)]
pub struct Slot {
    pub user: Pubkey,
    /// ORE round whose result decides this pick. Chosen by the program, never by the client.
    pub target_round: u64,
    /// ORE (raw units) owed after settlement.
    pub amount: u64,
    pub square: u8,
    pub pick_seq: u8,
    pub tier: u8,
    pub flags: u8,
    pub _pad: [u8; 4],
}

impl Slot {
    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

/// One run of the challenge. Terms are written once in `create_cohort` and no instruction edits them.
#[account(zero_copy)]
pub struct Cohort {
    /// Pays this account's and the SKR vault's rent and gets it back on close.
    pub creator: Pubkey,
    pub start_ts: i64,
    pub end_ts: i64,
    /// end + CLAIM_WINDOW_DAYS cohort days. Pick/claim close here; anyone may return and close after.
    pub deadline_ts: i64,
    pub deposit_amount: u64,
    pub fee_lamports: u64,
    pub common_amount: u64,
    /// Unclaimed part of this cohort's worst-case reservation.
    pub reserved: u64,
    pub paid: u64,
    pub id: u32,
    pub day_seconds: u32,
    pub kind: u8,
    pub days: u8,
    pub capacity: u8,
    pub participants: u8,
    pub picks: u8,
    pub next_settle: u8,
    pub legendary_awarded: u8,
    pub rare_awarded: u8,
    pub returned: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub _pad: [u8; 5],
    pub slots: [Slot; MAX_SLOTS],
}

impl Cohort {
    pub const SPACE: usize = 8 + core::mem::size_of::<Cohort>();

    pub fn slot_index(&self, user: &Pubkey) -> Result<usize> {
        self.slots[..self.participants as usize]
            .iter()
            .position(|s| s.user == *user)
            .ok_or_else(|| error!(LockedInError::NotParticipant))
    }

    pub fn last_day_start(&self) -> i64 {
        self.start_ts + (self.days as i64 - 1) * self.day_seconds as i64
    }

    pub fn joining_closes(&self) -> i64 {
        self.start_ts + self.day_seconds as i64
    }
}

/// Worst case a cohort can pay: every seat succeeds and the tier caps fill.
pub fn worst_case_reward(common: u64, capacity: u8) -> Result<u64> {
    let legendary = LEGENDARY_CAP.min(capacity);
    let rare = RARE_CAP.min(capacity - legendary);
    let rest = capacity - legendary - rare;
    common
        .checked_mul(
            LEGENDARY_MULTIPLIER * legendary as u64 + RARE_MULTIPLIER * rare as u64 + rest as u64,
        )
        .ok_or_else(|| error!(LockedInError::Overflow))
}

pub fn days_for_kind(kind: u8) -> Result<u8> {
    match kind {
        KIND_3_DAY => Ok(3),
        KIND_7_DAY => Ok(7),
        _ => err!(LockedInError::InvalidKind),
    }
}
