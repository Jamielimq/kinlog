//! Read-only view of ORE mining accounts (ore-api 3.8.x, "v4" layouts after June 2026).
//!
//! `ore-api` is not linked (its steel / solana-program 2.x tree conflicts with Anchor 1.x); the few
//! fields and the result math are ported here and checked against mainnet fixtures in tests.

use anchor_lang::prelude::*;

use crate::constants::{ORE_BOARD, ORE_PROGRAM_ID};
use crate::error::LockedInError;

pub const BOARD_DISCRIMINATOR: u8 = 105;
pub const BOARD_LEN: usize = 40;
pub const BOARD_ROUND_ID_OFFSET: usize = 8;

pub const ROUND_DISCRIMINATOR: u8 = 109;
pub const ROUND_LEN: usize = 952;
pub const ROUND_ID_OFFSET: usize = 8;
pub const ROUND_SLOT_HASH_OFFSET: usize = 616;

fn read_u64(data: &[u8], offset: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[offset..offset + 8]);
    u64::from_le_bytes(b)
}

/// steel discriminator: first byte is the account type, the next 7 are zero.
fn has_discriminator(data: &[u8], disc: u8) -> bool {
    data[0] == disc && data[1..8].iter().all(|b| *b == 0)
}

/// Current round id from the ORE Board. Validates address, owner, size and discriminator.
pub fn board_round_id(board: &AccountInfo) -> Result<u64> {
    require_keys_eq!(*board.key, ORE_BOARD, LockedInError::InvalidBoard);
    require_keys_eq!(*board.owner, ORE_PROGRAM_ID, LockedInError::InvalidBoard);
    let data = board.try_borrow_data()?;
    require!(
        data.len() == BOARD_LEN && has_discriminator(&data, BOARD_DISCRIMINATOR),
        LockedInError::InvalidBoard
    );
    Ok(read_u64(&data, BOARD_ROUND_ID_OFFSET))
}

pub fn round_address(round_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"round", &round_id.to_le_bytes()], &ORE_PROGRAM_ID).0
}

pub enum RoundState {
    /// Account is gone (closed after expiry) or no longer owned by ORE.
    Missing,
    /// Account exists; `None` until ORE's `reset` writes usable entropy.
    Present(Option<u64>),
}

/// Reads the round at the PDA for `round_id`. Any account at the wrong address is rejected outright;
/// at the right address, an empty or foreign-owned account means the round was closed.
pub fn read_round(round: &AccountInfo, round_id: u64) -> Result<RoundState> {
    require_keys_eq!(*round.key, round_address(round_id), LockedInError::InvalidRound);
    if *round.owner != ORE_PROGRAM_ID || round.data_is_empty() {
        return Ok(RoundState::Missing);
    }
    let data = round.try_borrow_data()?;
    require!(
        data.len() == ROUND_LEN && has_discriminator(&data, ROUND_DISCRIMINATOR),
        LockedInError::InvalidRound
    );
    require!(
        read_u64(&data, ROUND_ID_OFFSET) == round_id,
        LockedInError::InvalidRound
    );
    let mut slot_hash = [0u8; 32];
    slot_hash.copy_from_slice(&data[ROUND_SLOT_HASH_OFFSET..ROUND_SLOT_HASH_OFFSET + 32]);
    Ok(RoundState::Present(rng(&slot_hash)))
}

/// `Round::rng()`: XOR of the four little-endian u64 words; none if all 0x00 or all 0xFF.
pub fn rng(slot_hash: &[u8; 32]) -> Option<u64> {
    if slot_hash.iter().all(|b| *b == 0) || slot_hash.iter().all(|b| *b == 0xFF) {
        return None;
    }
    let mut r = 0u64;
    for i in 0..4 {
        r ^= read_u64(slot_hash, i * 8);
    }
    Some(r)
}

/// `Round::winning_square()`.
pub fn winning_square(rng: u64) -> u8 {
    (rng % 25) as u8
}

/// `Round::did_hit_motherlode()`: 1/500 since July 2026.
pub fn hit_motherlode(rng: u64) -> bool {
    rng.reverse_bits() % 500 == 0
}
