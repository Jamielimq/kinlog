use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

use crate::constants::*;
use crate::error::LockedInError;
use crate::events::*;
use crate::ore::{self, RoundState};
use crate::state::*;

/// The attester's only power: flag a participant as having met every day.
#[derive(Accounts)]
pub struct MarkSuccess<'info> {
    #[account(address = config.attester @ LockedInError::Unauthorized)]
    pub attester: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
}

pub fn handle_mark_success(ctx: Context<MarkSuccess>, user: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mut cohort = ctx.accounts.cohort.load_mut()?;
    require!(
        now >= cohort.last_day_start() && now < cohort.deadline_ts,
        LockedInError::SuccessWindowClosed
    );
    let i = cohort.slot_index(&user)?;
    cohort.slots[i].flags |= FLAG_SUCCESS;
    emit!(SuccessMarked {
        cohort: ctx.accounts.cohort.key(),
        user,
    });
    Ok(())
}

/// Records the participant's square before its result exists: the target is the round after the one
/// currently on ORE's board, read by the program itself.
#[derive(Accounts)]
pub struct PickSquare<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
    /// CHECK: validated as ORE's Board in `ore::board_round_id`.
    pub ore_board: UncheckedAccount<'info>,
}

pub fn handle_pick_square(ctx: Context<PickSquare>, square: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(square < BOARD_SQUARES, LockedInError::InvalidSquare);
    let current_round = ore::board_round_id(&ctx.accounts.ore_board.to_account_info())?;
    let target_round = current_round.checked_add(1).ok_or(LockedInError::Overflow)?;

    let user = ctx.accounts.user.key();
    let mut cohort = ctx.accounts.cohort.load_mut()?;
    require!(now < cohort.deadline_ts, LockedInError::DeadlinePassed);
    let i = cohort.slot_index(&user)?;
    require!(
        cohort.slots[i].has(FLAG_SUCCESS),
        LockedInError::NotSuccessful
    );
    require!(
        !cohort.slots[i].has(FLAG_PICKED),
        LockedInError::AlreadyPicked
    );
    let pick_seq = cohort.picks;
    let slot = &mut cohort.slots[i];
    slot.square = square;
    slot.target_round = target_round;
    slot.pick_seq = pick_seq;
    slot.flags |= FLAG_PICKED;
    cohort.picks += 1;

    emit!(SquarePicked {
        cohort: ctx.accounts.cohort.key(),
        user,
        square,
        target_round,
        pick_seq,
    });
    Ok(())
}

/// Settles the next pick in recording order. Anyone may call it; the result depends only on the
/// cohort state and ORE's accounts, so the caller cannot influence it.
///
/// Outcomes for the target round:
/// - revealed: tier from the round's result (then caps);
/// - closed after ORE moved past it (account gone at the exact PDA): Common. Settlement is normally
///   done within a minute; a pick left unsettled until its round expired is paid Common rather than
///   re-drawn, so delaying settlement after seeing a result can never buy a second draw;
/// - finished without entropy: not settleable here, see `retarget`;
/// - not revealed yet: rejected.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
    /// CHECK: validated as ORE's Board in `ore::board_round_id`.
    pub ore_board: UncheckedAccount<'info>,
    /// CHECK: must sit at the target round's PDA; validated in `ore::read_round`.
    pub ore_round: UncheckedAccount<'info>,
}

pub const SETTLE_REASON_REVEALED: u8 = 0;
pub const SETTLE_REASON_ROUND_CLOSED: u8 = 1;
/// `winning_square` value logged when the round was closed and no result could be read.
pub const NO_SQUARE: u8 = u8::MAX;

pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let current_round = ore::board_round_id(&ctx.accounts.ore_board.to_account_info())?;
    let mut cohort = ctx.accounts.cohort.load_mut()?;
    let seq = cohort.next_settle;
    require!(seq < cohort.picks, LockedInError::NotPicked);
    let i = cohort.slots[..cohort.participants as usize]
        .iter()
        .position(|s| s.has(FLAG_PICKED) && !s.has(FLAG_SETTLED) && s.pick_seq == seq)
        .ok_or(LockedInError::OutOfOrder)?;
    let target = cohort.slots[i].target_round;
    let finished = current_round > target;

    let (reason, winning_square, motherlode, raw_tier) =
        match ore::read_round(&ctx.accounts.ore_round.to_account_info(), target)? {
            RoundState::Present(Some(rng)) => {
                let ws = ore::winning_square(rng);
                let ml = ore::hit_motherlode(rng);
                let tier = if ml {
                    TIER_LEGENDARY
                } else if cohort.slots[i].square == ws {
                    TIER_RARE
                } else {
                    TIER_COMMON
                };
                (SETTLE_REASON_REVEALED, ws, ml, tier)
            }
            // A round's PDA is empty both before ORE creates it and after it is closed; only the
            // latter (board already past it) counts as closed.
            RoundState::Missing if finished => (SETTLE_REASON_ROUND_CLOSED, NO_SQUARE, false, TIER_COMMON),
            RoundState::Present(None) if finished => return err!(LockedInError::RoundNeedsRetarget),
            _ => return err!(LockedInError::RoundNotRevealed),
        };

    let mut tier = raw_tier;
    if tier == TIER_LEGENDARY && cohort.legendary_awarded >= LEGENDARY_CAP {
        tier = TIER_RARE;
    }
    if tier == TIER_RARE && cohort.rare_awarded >= RARE_CAP {
        tier = TIER_COMMON;
    }
    let multiplier = match tier {
        TIER_LEGENDARY => {
            cohort.legendary_awarded += 1;
            LEGENDARY_MULTIPLIER
        }
        TIER_RARE => {
            cohort.rare_awarded += 1;
            RARE_MULTIPLIER
        }
        _ => 1,
    };
    let amount = cohort
        .common_amount
        .checked_mul(multiplier)
        .ok_or(LockedInError::Overflow)?;

    let user = cohort.slots[i].user;
    let picked = cohort.slots[i].square;
    let slot = &mut cohort.slots[i];
    slot.tier = tier;
    slot.amount = amount;
    slot.flags |= FLAG_SETTLED;
    cohort.next_settle += 1;

    msg!(
        "Locked In settle: round {} reason {} winning_square {} picked {} motherlode {} tier {} amount {}",
        target,
        if reason == SETTLE_REASON_REVEALED { "revealed" } else { "round_closed" },
        winning_square,
        picked,
        motherlode,
        tier,
        amount
    );
    emit!(SquareSettled {
        cohort: ctx.accounts.cohort.key(),
        user,
        round_id: target,
        reason,
        winning_square,
        picked_square: picked,
        motherlode,
        tier,
        amount,
    });
    Ok(())
}

/// Moves a pick to a new round only when ORE has moved past its target round and that round finished
/// without usable entropy. A closed round is settled as Common instead (see `settle`), and a round
/// that is merely not revealed yet cannot be skipped.
#[derive(Accounts)]
pub struct Retarget<'info> {
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
    /// CHECK: validated as ORE's Board in `ore::board_round_id`.
    pub ore_board: UncheckedAccount<'info>,
    /// CHECK: must sit at the target round's PDA; validated in `ore::read_round`.
    pub ore_round: UncheckedAccount<'info>,
}

pub fn handle_retarget(ctx: Context<Retarget>, user: Pubkey) -> Result<()> {
    let current_round = ore::board_round_id(&ctx.accounts.ore_board.to_account_info())?;
    let mut cohort = ctx.accounts.cohort.load_mut()?;
    let i = cohort.slot_index(&user)?;
    let slot = cohort.slots[i];
    require!(slot.has(FLAG_PICKED), LockedInError::NotPicked);
    require!(!slot.has(FLAG_SETTLED), LockedInError::AlreadySettled);
    require!(
        current_round > slot.target_round,
        LockedInError::RetargetNotAllowed
    );
    let no_entropy = matches!(
        ore::read_round(&ctx.accounts.ore_round.to_account_info(), slot.target_round)?,
        RoundState::Present(None)
    );
    require!(no_entropy, LockedInError::RetargetNotAllowed);

    let to_round = current_round.checked_add(1).ok_or(LockedInError::Overflow)?;
    cohort.slots[i].target_round = to_round;
    msg!(
        "Locked In retarget: round {} finished without entropy, new target {}",
        slot.target_round,
        to_round
    );
    emit!(Retargeted {
        cohort: ctx.accounts.cohort.key(),
        user,
        from_round: slot.target_round,
        to_round,
    });
    Ok(())
}

/// The only way ORE leaves the reward vault.
#[derive(Accounts)]
pub struct ClaimReward<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub cohort: AccountLoader<'info, Cohort>,
    #[account(mut, seeds = [REWARD_VAULT_SEED], bump = config.reward_vault_bump)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = ore_mint,
        associated_token::authority = user,
    )]
    pub user_ore: Account<'info, TokenAccount>,
    #[account(address = ORE_MINT)]
    pub ore_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_reward(ctx: Context<ClaimReward>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let user = ctx.accounts.user.key();
    let amount = {
        let mut cohort = ctx.accounts.cohort.load_mut()?;
        require!(now < cohort.deadline_ts, LockedInError::DeadlinePassed);
        let i = cohort.slot_index(&user)?;
        require!(
            cohort.slots[i].has(FLAG_SETTLED),
            LockedInError::NotSettled
        );
        require!(
            !cohort.slots[i].has(FLAG_CLAIMED),
            LockedInError::AlreadyClaimed
        );
        let amount = cohort.slots[i].amount;
        cohort.slots[i].flags |= FLAG_CLAIMED;
        cohort.reserved = cohort
            .reserved
            .checked_sub(amount)
            .ok_or(LockedInError::Overflow)?;
        cohort.paid = cohort.paid.checked_add(amount).ok_or(LockedInError::Overflow)?;
        amount
    };
    let config = &mut ctx.accounts.config;
    config.reserved_total = config
        .reserved_total
        .checked_sub(amount)
        .ok_or(LockedInError::Overflow)?;

    let seeds: &[&[u8]] = &[CONFIG_SEED, &[config.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.reward_vault.to_account_info(),
                mint: ctx.accounts.ore_mint.to_account_info(),
                to: ctx.accounts.user_ore.to_account_info(),
                authority: config.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ORE_DECIMALS,
    )?;
    emit!(RewardClaimed {
        cohort: ctx.accounts.cohort.key(),
        user,
        amount,
    });
    Ok(())
}
