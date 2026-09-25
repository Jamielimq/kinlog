//! Kinlog Locked In.
//!
//! Participants deposit SKR (returned in full, pass or fail) and pay a SOL Fee to join a cohort. Those
//! who complete every day pick one of 25 squares; the tier is decided by the next ORE mining round and
//! paid in ORE from a program-owned vault. Design: docs/LOCKED_IN.md.
//!
//! Invariants:
//! - The only way ORE leaves the reward vault is `claim_reward`.
//! - SKR leaves a cohort vault only to the depositor (`withdraw`, `return_deposit`), and only after
//!   the cohort ends. There is no cancel instruction.
//! - Cohort terms are written once in `create_cohort`; no instruction edits them.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod ore;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("9vG8Qcwvv5uWbHJsvxT6G2HHCD7punB1tYhRLJW5wcby");

#[program]
pub mod locked_in {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        admin: Pubkey,
        fee_wallet: Pubkey,
        roles: Roles,
        limits: Limits,
    ) -> Result<()> {
        instructions::admin::handle_init_config(ctx, admin, fee_wallet, roles, limits)
    }

    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        instructions::admin::handle_set_admin(ctx, new_admin)
    }

    pub fn set_roles(ctx: Context<AdminOnly>, roles: Roles) -> Result<()> {
        instructions::admin::handle_set_roles(ctx, roles)
    }

    pub fn set_limits(ctx: Context<AdminOnly>, limits: Limits) -> Result<()> {
        instructions::admin::handle_set_limits(ctx, limits)
    }

    pub fn set_fee_wallet(ctx: Context<AdminOnly>, fee_wallet: Pubkey) -> Result<()> {
        instructions::admin::handle_set_fee_wallet(ctx, fee_wallet)
    }

    pub fn pause_deposits(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::admin::handle_pause_deposits(ctx, paused)
    }

    pub fn create_cohort(
        ctx: Context<CreateCohort>,
        kind: u8,
        id: u32,
        start_ts: i64,
        day_seconds: u32,
        deposit_amount: u64,
        common_amount: u64,
    ) -> Result<()> {
        instructions::cohort::handle_create_cohort(
            ctx,
            kind,
            id,
            start_ts,
            day_seconds,
            deposit_amount,
            common_amount,
        )
    }

    pub fn deposit(ctx: Context<Deposit>) -> Result<()> {
        instructions::deposit::handle_deposit(ctx)
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        instructions::deposit::handle_withdraw(ctx)
    }

    pub fn return_deposit(ctx: Context<ReturnDeposit>) -> Result<()> {
        instructions::deposit::handle_return_deposit(ctx)
    }

    pub fn mark_success(ctx: Context<MarkSuccess>, user: Pubkey) -> Result<()> {
        instructions::reward::handle_mark_success(ctx, user)
    }

    pub fn pick_square(ctx: Context<PickSquare>, square: u8) -> Result<()> {
        instructions::reward::handle_pick_square(ctx, square)
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::reward::handle_settle(ctx)
    }

    pub fn retarget(ctx: Context<Retarget>, user: Pubkey) -> Result<()> {
        instructions::reward::handle_retarget(ctx, user)
    }

    pub fn claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
        instructions::reward::handle_claim_reward(ctx)
    }

    pub fn close_cohort(ctx: Context<CloseCohort>) -> Result<()> {
        instructions::cohort::handle_close_cohort(ctx)
    }
}
