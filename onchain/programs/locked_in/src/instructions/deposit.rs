use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::LockedInError;
use crate::events::{DepositReturned, Deposited};
use crate::state::*;

/// Joins a cohort: the SKR deposit and the non-refundable Fee move in one instruction, so there is
/// no way to deposit without paying the Fee.
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
    #[account(mut, seeds = [SKR_VAULT_SEED, cohort.key().as_ref()], bump)]
    pub skr_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = skr_mint, token::authority = user)]
    pub user_skr: Account<'info, TokenAccount>,
    #[account(address = SKR_MINT)]
    pub skr_mint: Account<'info, Mint>,
    /// CHECK: must be the configured fee wallet; only receives lamports.
    #[account(mut, address = config.fee_wallet @ LockedInError::Unauthorized)]
    pub fee_wallet: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(ctx: Context<Deposit>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.config.deposits_paused,
        LockedInError::DepositsPaused
    );
    let user = ctx.accounts.user.key();
    let (amount, fee) = {
        let mut cohort = ctx.accounts.cohort.load_mut()?;
        // The success condition starts on day one, so a later joiner could never pass.
        require!(now < cohort.joining_closes(), LockedInError::JoiningClosed);
        require!(
            cohort.participants < cohort.capacity,
            LockedInError::CohortFull
        );
        require!(
            cohort.slot_index(&user).is_err(),
            LockedInError::AlreadyJoined
        );
        let i = cohort.participants as usize;
        cohort.slots[i] = Slot {
            user,
            flags: FLAG_OCCUPIED,
            ..Slot::default()
        };
        cohort.participants += 1;
        (cohort.deposit_amount, cohort.fee_lamports)
    };

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.user_skr.to_account_info(),
                mint: ctx.accounts.skr_mint.to_account_info(),
                to: ctx.accounts.skr_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        SKR_DECIMALS,
    )?;
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.fee_wallet.to_account_info(),
            },
        ),
        fee,
    )?;

    emit!(Deposited {
        cohort: ctx.accounts.cohort.key(),
        user,
        amount,
        fee_lamports: fee,
    });
    Ok(())
}

fn pay_out_deposit<'info>(
    cohort_loader: &AccountLoader<'info, Cohort>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    destination: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    depositor: Pubkey,
    by_owner: bool,
) -> Result<()> {
    let (amount, kind, id, bump) = {
        let mut cohort = cohort_loader.load_mut()?;
        let i = cohort.slot_index(&depositor)?;
        require!(
            !cohort.slots[i].has(FLAG_RETURNED),
            LockedInError::AlreadyReturned
        );
        // Only SKR moves; the slot (pick, tier, claim state) stays until the cohort closes.
        cohort.slots[i].flags |= FLAG_RETURNED;
        cohort.returned += 1;
        (cohort.deposit_amount, cohort.kind, cohort.id, cohort.bump)
    };
    let id_bytes = id.to_le_bytes();
    let seeds: &[&[u8]] = &[COHORT_SEED, &[kind], &id_bytes, &[bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: destination.to_account_info(),
                authority: cohort_loader.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        SKR_DECIMALS,
    )?;
    emit!(DepositReturned {
        cohort: cohort_loader.key(),
        user: depositor,
        amount,
        by_owner,
    });
    Ok(())
}

/// The depositor takes their SKR back after the end, into any SKR account they own.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
    #[account(mut, seeds = [SKR_VAULT_SEED, cohort.key().as_ref()], bump)]
    pub skr_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = skr_mint, token::authority = user)]
    pub user_skr: Account<'info, TokenAccount>,
    #[account(address = SKR_MINT)]
    pub skr_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.cohort.load()?.end_ts,
        LockedInError::CohortNotEnded
    );
    pay_out_deposit(
        &ctx.accounts.cohort,
        &ctx.accounts.skr_vault,
        &ctx.accounts.skr_mint,
        &ctx.accounts.user_skr,
        &ctx.accounts.token_program,
        ctx.accounts.user.key(),
        true,
    )
}

/// Returns a deposit on the depositor's behalf. The crank may do so after the end; anyone may after
/// the deadline. The destination is always the depositor's own SKR associated token account.
#[derive(Accounts)]
pub struct ReturnDeposit<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
    #[account(mut, seeds = [SKR_VAULT_SEED, cohort.key().as_ref()], bump)]
    pub skr_vault: Account<'info, TokenAccount>,
    /// CHECK: identifies the slot; the handler requires a matching participant.
    pub depositor: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = skr_mint,
        associated_token::authority = depositor,
    )]
    pub depositor_skr: Account<'info, TokenAccount>,
    #[account(address = SKR_MINT)]
    pub skr_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_return_deposit(ctx: Context<ReturnDeposit>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let cohort = ctx.accounts.cohort.load()?;
        let opens_at = if ctx.accounts.caller.key() == ctx.accounts.config.crank {
            cohort.end_ts
        } else {
            cohort.deadline_ts
        };
        require!(now >= opens_at, LockedInError::CohortNotEnded);
    }
    pay_out_deposit(
        &ctx.accounts.cohort,
        &ctx.accounts.skr_vault,
        &ctx.accounts.skr_mint,
        &ctx.accounts.depositor_skr,
        &ctx.accounts.token_program,
        ctx.accounts.depositor.key(),
        false,
    )
}
