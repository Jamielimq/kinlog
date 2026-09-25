use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::LockedInError;
use crate::program::LockedIn;
use crate::state::Config;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Limits {
    pub fee_lamports: u64,
    pub deposit_amount_max: u64,
    pub max_reward_per_box: u64,
    pub min_day_seconds: u32,
    pub max_capacity: u8,
    pub max_live_cohorts: [u8; KIND_COUNT],
}

impl Limits {
    fn validate(&self) -> Result<()> {
        require!(
            self.fee_lamports > 0
                && self.deposit_amount_max > 0
                && self.max_reward_per_box > 0
                && self.min_day_seconds > 0
                && self.min_day_seconds <= SECONDS_PER_DAY
                && self.max_capacity > 0
                && self.max_capacity as usize <= MAX_SLOTS
                && self.max_live_cohorts.iter().all(|n| *n > 0),
            LockedInError::InvalidLimit
        );
        Ok(())
    }

    fn apply(&self, config: &mut Config) {
        config.fee_lamports = self.fee_lamports;
        config.deposit_amount_max = self.deposit_amount_max;
        config.max_reward_per_box = self.max_reward_per_box;
        config.min_day_seconds = self.min_day_seconds;
        config.max_capacity = self.max_capacity;
        config.max_live_cohorts = self.max_live_cohorts;
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Roles {
    pub cohort_creator: Pubkey,
    pub attester: Pubkey,
    pub crank: Pubkey,
}

/// One-time setup, callable only by the program's current upgrade authority (the deployer), so nobody
/// can front-run initialization after deploy. Admin is handed to the Squads vault here.
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ LockedInError::Unauthorized
    )]
    pub program: Program<'info, LockedIn>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ LockedInError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(address = ORE_MINT)]
    pub ore_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [REWARD_VAULT_SEED],
        bump,
        token::mint = ore_mint,
        token::authority = config,
    )]
    pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_config(
    ctx: Context<InitConfig>,
    admin: Pubkey,
    fee_wallet: Pubkey,
    roles: Roles,
    limits: Limits,
) -> Result<()> {
    limits.validate()?;
    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.fee_wallet = fee_wallet;
    config.cohort_creator = roles.cohort_creator;
    config.attester = roles.attester;
    config.crank = roles.crank;
    limits.apply(config);
    config.reserved_total = 0;
    config.live_cohorts = [0; KIND_COUNT];
    config.deposits_paused = false;
    config.bump = ctx.bumps.config;
    config.reward_vault_bump = ctx.bumps.reward_vault;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = config.admin @ LockedInError::Unauthorized)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
}

pub fn handle_set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.admin = new_admin;
    Ok(())
}

pub fn handle_set_roles(ctx: Context<AdminOnly>, roles: Roles) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.cohort_creator = roles.cohort_creator;
    config.attester = roles.attester;
    config.crank = roles.crank;
    Ok(())
}

pub fn handle_set_limits(ctx: Context<AdminOnly>, limits: Limits) -> Result<()> {
    limits.validate()?;
    limits.apply(&mut ctx.accounts.config);
    Ok(())
}

pub fn handle_set_fee_wallet(ctx: Context<AdminOnly>, fee_wallet: Pubkey) -> Result<()> {
    ctx.accounts.config.fee_wallet = fee_wallet;
    Ok(())
}

/// Stops new deposits only. Withdraw, return, settle and claim keep working.
pub fn handle_pause_deposits(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.config.deposits_paused = paused;
    Ok(())
}
