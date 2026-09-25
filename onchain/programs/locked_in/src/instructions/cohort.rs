use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, CloseAccount, Mint, Token, TokenAccount};

use crate::constants::*;
use crate::error::LockedInError;
use crate::events::CohortClosed;
use crate::state::*;

#[derive(Accounts)]
#[instruction(kind: u8, id: u32)]
pub struct CreateCohort<'info> {
    #[account(mut, address = config.cohort_creator @ LockedInError::Unauthorized)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = creator,
        space = Cohort::SPACE,
        seeds = [COHORT_SEED, &[kind], &id.to_le_bytes()],
        bump,
    )]
    pub cohort: AccountLoader<'info, Cohort>,
    #[account(
        init,
        payer = creator,
        seeds = [SKR_VAULT_SEED, cohort.key().as_ref()],
        bump,
        token::mint = skr_mint,
        token::authority = cohort,
    )]
    pub skr_vault: Account<'info, TokenAccount>,
    #[account(address = SKR_MINT)]
    pub skr_mint: Account<'info, Mint>,
    #[account(seeds = [REWARD_VAULT_SEED], bump = config.reward_vault_bump)]
    pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_cohort(
    ctx: Context<CreateCohort>,
    kind: u8,
    id: u32,
    start_ts: i64,
    day_seconds: u32,
    deposit_amount: u64,
    common_amount: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    let days = days_for_kind(kind)?;

    require!(
        day_seconds >= config.min_day_seconds && day_seconds <= SECONDS_PER_DAY,
        LockedInError::InvalidDayLength
    );
    // Real cohorts sit on the shared 15:00 UTC day boundary; shorter test cohorts may start any time.
    if day_seconds == SECONDS_PER_DAY {
        require!(
            start_ts.rem_euclid(SECONDS_PER_DAY as i64) == REAL_COHORT_START_OFFSET,
            LockedInError::MisalignedStart
        );
    }
    require!(start_ts > now, LockedInError::StartInPast);
    let end_ts = start_ts + days as i64 * day_seconds as i64;
    require!(end_ts <= now + MAX_END_AHEAD, LockedInError::EndTooFar);
    let deadline_ts = end_ts + CLAIM_WINDOW_DAYS * day_seconds as i64;

    require!(
        deposit_amount > 0 && deposit_amount <= config.deposit_amount_max,
        LockedInError::InvalidDepositAmount
    );
    require!(
        common_amount > 0 && common_amount % ORE_REWARD_GRANULARITY == 0,
        LockedInError::InvalidRewardAmount
    );
    let legendary = common_amount
        .checked_mul(LEGENDARY_MULTIPLIER)
        .ok_or(LockedInError::Overflow)?;
    require!(
        legendary <= config.max_reward_per_box,
        LockedInError::RewardAboveMax
    );

    let k = kind as usize;
    require!(
        config.live_cohorts[k] < config.max_live_cohorts[k],
        LockedInError::TooManyLiveCohorts
    );

    let capacity = config.max_capacity;
    let reserve = worst_case_reward(common_amount, capacity)?;
    let unreserved = ctx
        .accounts
        .reward_vault
        .amount
        .checked_sub(config.reserved_total)
        .ok_or(LockedInError::Overflow)?;
    require!(unreserved >= reserve, LockedInError::InsufficientRewardVault);

    config.reserved_total = config
        .reserved_total
        .checked_add(reserve)
        .ok_or(LockedInError::Overflow)?;
    config.live_cohorts[k] += 1;

    let mut cohort = ctx.accounts.cohort.load_init()?;
    cohort.creator = ctx.accounts.creator.key();
    cohort.start_ts = start_ts;
    cohort.end_ts = end_ts;
    cohort.deadline_ts = deadline_ts;
    cohort.deposit_amount = deposit_amount;
    cohort.fee_lamports = config.fee_lamports;
    cohort.common_amount = common_amount;
    cohort.reserved = reserve;
    cohort.id = id;
    cohort.day_seconds = day_seconds;
    cohort.kind = kind;
    cohort.days = days;
    cohort.capacity = capacity;
    cohort.bump = ctx.bumps.cohort;
    cohort.vault_bump = ctx.bumps.skr_vault;
    Ok(())
}

/// After the deadline, once every deposit is back: expire unclaimed rewards, release the unused
/// reservation, and close the vault and cohort. Rent returns to the recorded creator only.
#[derive(Accounts)]
pub struct CloseCohort<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = creator)]
    pub cohort: AccountLoader<'info, Cohort>,
    /// CHECK: must equal cohort.creator (checked in handler); only receives lamports.
    #[account(mut)]
    pub creator: UncheckedAccount<'info>,
    #[account(mut, seeds = [SKR_VAULT_SEED, cohort.key().as_ref()], bump)]
    pub skr_vault: Account<'info, TokenAccount>,
    #[account(mut, address = SKR_MINT)]
    pub skr_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_close_cohort(ctx: Context<CloseCohort>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (kind, id, bump, reserved) = {
        let cohort = ctx.accounts.cohort.load()?;
        require_keys_eq!(
            ctx.accounts.creator.key(),
            cohort.creator,
            LockedInError::Unauthorized
        );
        require!(now >= cohort.deadline_ts, LockedInError::DeadlineNotPassed);
        require!(
            cohort.returned == cohort.participants,
            LockedInError::DepositsOutstanding
        );
        (cohort.kind, cohort.id, cohort.bump, cohort.reserved)
    };

    let id_bytes = id.to_le_bytes();
    let seeds: &[&[u8]] = &[COHORT_SEED, &[kind], &id_bytes, &[bump]];
    let signer = &[seeds];

    // Every deposit is back, so anything left is dust someone sent in. Burning it favours nobody and
    // keeps a stray transfer from blocking the close (and with it the live-cohort counter).
    let dust = ctx.accounts.skr_vault.amount;
    if dust > 0 {
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.skr_mint.to_account_info(),
                    from: ctx.accounts.skr_vault.to_account_info(),
                    authority: ctx.accounts.cohort.to_account_info(),
                },
                signer,
            ),
            dust,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.key(),
        CloseAccount {
            account: ctx.accounts.skr_vault.to_account_info(),
            destination: ctx.accounts.creator.to_account_info(),
            authority: ctx.accounts.cohort.to_account_info(),
        },
        signer,
    ))?;

    let config = &mut ctx.accounts.config;
    config.reserved_total = config
        .reserved_total
        .checked_sub(reserved)
        .ok_or(LockedInError::Overflow)?;
    config.live_cohorts[kind as usize] -= 1;

    emit!(CohortClosed {
        cohort: ctx.accounts.cohort.key(),
        released: reserved,
        burned_dust: dust,
    });
    Ok(())
}
