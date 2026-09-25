use anchor_lang::prelude::*;

#[event]
pub struct Deposited {
    pub cohort: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub fee_lamports: u64,
}

#[event]
pub struct DepositReturned {
    pub cohort: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub by_owner: bool,
}

#[event]
pub struct SuccessMarked {
    pub cohort: Pubkey,
    pub user: Pubkey,
}

#[event]
pub struct SquarePicked {
    pub cohort: Pubkey,
    pub user: Pubkey,
    pub square: u8,
    pub target_round: u64,
    pub pick_seq: u8,
}

#[event]
pub struct SquareSettled {
    pub cohort: Pubkey,
    pub user: Pubkey,
    pub round_id: u64,
    /// 0 = result read from the round, 1 = round closed before settlement (paid Common).
    pub reason: u8,
    /// 255 when the round was closed.
    pub winning_square: u8,
    pub picked_square: u8,
    pub motherlode: bool,
    /// 1 Common, 2 Rare, 3 Legendary (after caps).
    pub tier: u8,
    pub amount: u64,
}

#[event]
pub struct Retargeted {
    pub cohort: Pubkey,
    pub user: Pubkey,
    pub from_round: u64,
    pub to_round: u64,
}

#[event]
pub struct RewardClaimed {
    pub cohort: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
}

#[event]
pub struct CohortClosed {
    pub cohort: Pubkey,
    pub released: u64,
    pub burned_dust: u64,
}
