//! Attempts that must fail. Each invariant is exercised from the attacker's side, not only the
//! happy path.
mod common;

use anchor_lang::{
    prelude::Pubkey,
    solana_program::instruction::{AccountMeta, Instruction},
    InstructionData,
};
use common::*;
use locked_in::{constants::*, state::*};
use solana_keypair::Keypair;
use solana_signer::Signer;

const K: u8 = KIND_3_DAY;
const ID: u32 = 20261004;

fn joined(n: usize) -> (Env, Vec<Keypair>, i64) {
    let mut env = Env::ready(ORE);
    let start = env.create_real_cohort(K, ID);
    env.set_time(start - 60);
    let users = env.join_many(K, ID, n);
    (env, users, start)
}

// ---- Program surface ------------------------------------------------------------------------------

fn idl() -> serde_json::Value {
    let p = format!("{}/../../target/idl/locked_in.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn instructions_writing(account: &str) -> Vec<String> {
    let mut v: Vec<String> = idl()["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|ix| {
            ix["accounts"].as_array().unwrap().iter().any(|a| {
                a["name"] == account && a["writable"].as_bool().unwrap_or(false)
            })
        })
        .map(|ix| ix["name"].as_str().unwrap().to_string())
        .collect();
    v.sort();
    v
}

#[test]
fn instruction_set_has_no_cancel_or_admin_withdrawal() {
    let mut names: Vec<String> = idl()["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|ix| ix["name"].as_str().unwrap().to_string())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "claim_reward", "close_cohort", "create_cohort", "deposit", "init_config",
            "mark_success", "pause_deposits", "pick_square", "retarget", "return_deposit",
            "set_admin", "set_fee_wallet", "set_limits", "set_roles", "settle", "withdraw",
        ]
    );
}

#[test]
fn only_claim_reward_writes_the_reward_vault_after_setup() {
    // init_config creates it (once, see init_config_runs_once); claim_reward is the only other writer.
    assert_eq!(instructions_writing("reward_vault"), ["claim_reward", "init_config"]);
}

#[test]
fn skr_vault_writers_are_the_deposit_lifecycle_only() {
    assert_eq!(
        instructions_writing("skr_vault"),
        ["close_cohort", "create_cohort", "deposit", "return_deposit", "withdraw"]
    );
}

#[test]
fn vault_tokens_cannot_move_without_the_program_signing() {
    let (mut env, users, _) = joined(1);
    let thief = env.user(0);
    let thief_ore = Pubkey::new_unique();
    env.set_token_amount(thief_ore, ORE_MINT, thief.pubkey(), 0);
    let thief_skr = env.skr_ata(&thief.pubkey());
    // SPL Token Transfer (tag 3) with the PDA as an unsigned authority.
    let transfer = |src: Pubkey, dst: Pubkey, auth: Pubkey| {
        let mut data = vec![3u8];
        data.extend_from_slice(&1u64.to_le_bytes());
        Instruction {
            program_id: spl_token_id(),
            accounts: vec![
                AccountMeta::new(src, false),
                AccountMeta::new(dst, false),
                AccountMeta::new_readonly(auth, false),
            ],
            data,
        }
    };
    let ix = transfer(reward_vault_pda(), thief_ore, config_pda());
    assert!(env.send(&[ix], &[&thief]).is_err());
    let cohort = cohort_pda(K, ID);
    let ix = transfer(skr_vault_pda(&cohort), thief_skr, cohort);
    assert!(env.send(&[ix], &[&thief]).is_err());
    assert_eq!(env.token_amount(&skr_vault_pda(&cohort)), DEPOSIT);
    let _ = users;
}

// ---- Setup and admin ------------------------------------------------------------------------------

#[test]
fn init_config_requires_upgrade_authority() {
    let mut env = Env::new();
    let impostor = env.user(0);
    expect_err(env.init_config(&impostor), "Unauthorized");
    let admin = env.admin.insecure_clone();
    expect_err(env.init_config(&admin), "Unauthorized");
}

#[test]
fn init_config_runs_once() {
    let mut env = Env::ready(ORE);
    let deployer = env.deployer.insecure_clone();
    assert!(env.init_config(&deployer).is_err());
}

#[test]
fn admin_instructions_reject_every_other_key() {
    let mut env = Env::ready(ORE);
    let others = [env.creator.insecure_clone(), env.attester.insecure_clone(), env.crank.insecure_clone(), env.deployer.insecure_clone()];
    for k in &others {
        let calls: Vec<Vec<u8>> = vec![
            locked_in::instruction::SetAdmin { new_admin: k.pubkey() }.data(),
            locked_in::instruction::SetFeeWallet { fee_wallet: k.pubkey() }.data(),
            locked_in::instruction::SetLimits { limits: Env::default_limits() }.data(),
            locked_in::instruction::PauseDeposits { paused: true }.data(),
            locked_in::instruction::SetRoles {
                roles: locked_in::Roles { cohort_creator: k.pubkey(), attester: k.pubkey(), crank: k.pubkey() },
            }
            .data(),
        ];
        for data in calls {
            let ix = env.admin_ix(&k.pubkey(), data);
            expect_err(env.send(&[ix], &[k]), "Unauthorized");
        }
    }
    assert_eq!(env.config().fee_wallet, env.fee_wallet);
}

#[test]
fn fee_wallet_changes_only_through_admin() {
    let mut env = Env::ready(ORE);
    let admin = env.admin.insecure_clone();
    let new_wallet = Pubkey::new_unique();
    let ix = env.admin_ix(&admin.pubkey(), locked_in::instruction::SetFeeWallet { fee_wallet: new_wallet }.data());
    ok(env.send(&[ix], &[&admin]));
    assert_eq!(env.config().fee_wallet, new_wallet);
}

#[test]
fn limits_are_validated() {
    let mut env = Env::ready(ORE);
    let admin = env.admin.insecure_clone();
    let mut bad = Env::default_limits();
    bad.max_capacity = 31;
    let ix = env.admin_ix(&admin.pubkey(), locked_in::instruction::SetLimits { limits: bad }.data());
    expect_err(env.send(&[ix], &[&admin]), "InvalidLimit");
    let mut bad = Env::default_limits();
    bad.min_day_seconds = 86_401;
    let ix = env.admin_ix(&admin.pubkey(), locked_in::instruction::SetLimits { limits: bad }.data());
    expect_err(env.send(&[ix], &[&admin]), "InvalidLimit");
}

// ---- create_cohort ----------------------------------------------------------------------------------

#[test]
fn create_cohort_guards() {
    let mut env = Env::ready(ORE);
    let creator = env.creator.insecure_clone();
    let start = next_aligned_start(env.now);
    let c = creator.pubkey();
    let cases: Vec<(Instruction, &str)> = vec![
        (env.create_cohort_ix(&c, K, 1, start + 60, DAY as u32, DEPOSIT, COMMON), "MisalignedStart"),
        (env.create_cohort_ix(&c, K, 1, start - DAY, DAY as u32, DEPOSIT, COMMON), "StartInPast"),
        (env.create_cohort_ix(&c, K, 1, start + 28 * DAY, DAY as u32, DEPOSIT, COMMON), "EndTooFar"),
        (env.create_cohort_ix(&c, K, 1, start, 600, DEPOSIT, COMMON), "InvalidDayLength"),
        (env.create_cohort_ix(&c, K, 1, start, DAY as u32 + 1, DEPOSIT, COMMON), "InvalidDayLength"),
        (env.create_cohort_ix(&c, 2, 1, start, DAY as u32, DEPOSIT, COMMON), "InvalidKind"),
        (env.create_cohort_ix(&c, K, 1, start, DAY as u32, 0, COMMON), "InvalidDepositAmount"),
        (env.create_cohort_ix(&c, K, 1, start, DAY as u32, 1_001 * SKR, COMMON), "InvalidDepositAmount"),
        (env.create_cohort_ix(&c, K, 1, start, DAY as u32, DEPOSIT, COMMON + 1), "InvalidRewardAmount"),
        (env.create_cohort_ix(&c, K, 1, start, DAY as u32, DEPOSIT, 0), "InvalidRewardAmount"),
        (env.create_cohort_ix(&c, K, 1, start, DAY as u32, DEPOSIT, MAX_REWARD_PER_BOX / 20 + 1_000_000), "RewardAboveMax"),
    ];
    for (ix, err) in cases {
        expect_err(env.send(&[ix], &[&creator]), err);
    }
    // Only the cohort creator key.
    for k in [env.admin.insecure_clone(), env.attester.insecure_clone(), env.crank.insecure_clone()] {
        let ix = env.create_cohort_ix(&k.pubkey(), K, 1, start, DAY as u32, DEPOSIT, COMMON);
        expect_err(env.send(&[ix], &[&k]), "Unauthorized");
    }
}

#[test]
fn live_cohort_limit_per_kind() {
    let mut env = Env::ready(10 * ORE);
    let start = next_aligned_start(env.now);
    let creator = env.creator.insecure_clone();
    for i in 0..4u32 {
        let ix = env.create_cohort_ix(&creator.pubkey(), K, i, start + i as i64 * DAY, DAY as u32, DEPOSIT, COMMON);
        ok(env.send(&[ix], &[&creator]));
    }
    let ix = env.create_cohort_ix(&creator.pubkey(), K, 9, start + 5 * DAY, DAY as u32, DEPOSIT, COMMON);
    expect_err(env.send(&[ix], &[&creator]), "TooManyLiveCohorts");
    // The other kind has its own limit.
    let ix = env.create_cohort_ix(&creator.pubkey(), KIND_7_DAY, 9, start, DAY as u32, DEPOSIT, COMMON);
    ok(env.send(&[ix], &[&creator]));
}

#[test]
fn reservation_never_exceeds_the_vault() {
    // Room for one worst case and a half.
    let mut env = Env::ready(COMMON * 52 * 3 / 2);
    let start = next_aligned_start(env.now);
    let creator = env.creator.insecure_clone();
    let ix = env.create_cohort_ix(&creator.pubkey(), K, 1, start, DAY as u32, DEPOSIT, COMMON);
    ok(env.send(&[ix], &[&creator]));
    let ix = env.create_cohort_ix(&creator.pubkey(), K, 2, start + 3 * DAY, DAY as u32, DEPOSIT, COMMON);
    expect_err(env.send(&[ix], &[&creator]), "InsufficientRewardVault");
    let cfg = env.config();
    assert!(cfg.reserved_total <= env.token_amount(&reward_vault_pda()));
}

// ---- deposit --------------------------------------------------------------------------------------

#[test]
fn deposit_window_is_before_start_and_day_one_only() {
    let mut env = Env::ready(ORE);
    let start = env.create_real_cohort(K, ID);
    let a = env.user(DEPOSIT);
    let b = env.user(DEPOSIT);
    env.set_time(start + DAY - 1);
    ok(env.deposit(&a, K, ID));
    env.set_time(start + DAY);
    expect_err(env.deposit(&b, K, ID), "JoiningClosed");
}

#[test]
fn deposit_capacity_and_duplicates() {
    let (mut env, users, _) = joined(30);
    let late = env.user(DEPOSIT);
    expect_err(env.deposit(&late, K, ID), "CohortFull");
    let mut env2 = Env::ready(ORE);
    let start = env2.create_real_cohort(K, ID);
    env2.set_time(start - 60);
    let u = env2.user(2 * DEPOSIT);
    ok(env2.deposit(&u, K, ID));
    expect_err(env2.deposit(&u, K, ID), "AlreadyJoined");
    assert_eq!(env.cohort(K, ID).participants, 30);
    let _ = users;
}

#[test]
fn fee_cannot_be_skipped_or_redirected() {
    let mut env = Env::ready(ORE);
    let start = env.create_real_cohort(K, ID);
    env.set_time(start - 60);
    let u = env.user(DEPOSIT);
    // Fee sent to the user's own account instead of the configured wallet.
    let ix = env.deposit_ix(&u.pubkey(), K, ID, u.pubkey(), env.skr_ata(&u.pubkey()));
    expect_err(env.send(&[ix], &[&u]), "Unauthorized");
    let ix = env.deposit_ix(&u.pubkey(), K, ID, Pubkey::new_unique(), env.skr_ata(&u.pubkey()));
    expect_err(env.send(&[ix], &[&u]), "Unauthorized");
    // A wallet that cannot pay the Fee cannot deposit: the whole instruction fails, SKR stays put.
    let poor = Keypair::new();
    // Rent-exempt but short of the 0.001 SOL Fee.
    env.svm
        .set_account(
            poor.pubkey(),
            solana_account::Account { lamports: 950_000, data: vec![], owner: anchor_lang::solana_program::system_program::ID, executable: false, rent_epoch: 0 },
        )
        .unwrap();
    env.set_token_amount(env.skr_ata(&poor.pubkey()), SKR_MINT, poor.pubkey(), DEPOSIT);
    assert!(env.deposit(&poor, K, ID).is_err());
    assert_eq!(env.token_amount(&env.skr_ata(&poor.pubkey())), DEPOSIT);
    assert_eq!(env.cohort(K, ID).participants, 0);
}

#[test]
fn look_alike_skr_is_rejected() {
    let mut env = Env::ready(ORE);
    let start = env.create_real_cohort(K, ID);
    env.set_time(start - 60);
    let u = env.user(0);
    let fake_mint = Pubkey::new_unique();
    let mut mint = vec![0u8; 82];
    mint[36..44].copy_from_slice(&(1_000 * SKR).to_le_bytes());
    mint[44] = 6;
    mint[45] = 1;
    env.set_raw(fake_mint, spl_token_id(), mint);
    let fake_acc = Pubkey::new_unique();
    env.set_token_amount(fake_acc, fake_mint, u.pubkey(), DEPOSIT);
    let ix = env.deposit_ix(&u.pubkey(), K, ID, env.fee_wallet, fake_acc);
    expect_err(env.send(&[ix], &[&u]), "ConstraintTokenMint");
    // Swapping the mint account itself.
    let mut ix = env.deposit_ix(&u.pubkey(), K, ID, env.fee_wallet, fake_acc);
    for m in ix.accounts.iter_mut() {
        if m.pubkey == SKR_MINT {
            m.pubkey = fake_mint;
        }
    }
    expect_err(env.send(&[ix], &[&u]), "ConstraintAddress");
}

#[test]
fn deposit_from_someone_elses_account_is_rejected() {
    let mut env = Env::ready(ORE);
    let start = env.create_real_cohort(K, ID);
    env.set_time(start - 60);
    let victim = env.user(DEPOSIT);
    let thief = env.user(0);
    let ix = env.deposit_ix(&thief.pubkey(), K, ID, env.fee_wallet, env.skr_ata(&victim.pubkey()));
    expect_err(env.send(&[ix], &[&thief]), "ConstraintTokenOwner");
}

#[test]
fn pause_blocks_new_deposits_only() {
    let (mut env, users, start) = joined(1);
    let admin = env.admin.insecure_clone();
    let ix = env.admin_ix(&admin.pubkey(), locked_in::instruction::PauseDeposits { paused: true }.data());
    ok(env.send(&[ix], &[&admin]));
    let late = env.user(DEPOSIT);
    expect_err(env.deposit(&late, K, ID), "DepositsPaused");
    env.set_time(start + 3 * DAY);
    ok(env.withdraw(&users[0], K, ID));
}

// ---- no exit before the end -----------------------------------------------------------------------

#[test]
fn nobody_gets_skr_out_before_the_end() {
    let (mut env, users, start) = joined(1);
    let u = &users[0];
    for t in [start - 1, start + DAY, start + 3 * DAY - 1] {
        env.set_time(t);
        expect_err(env.withdraw(u, K, ID), "CohortNotEnded");
        let crank = env.crank.insecure_clone();
        expect_err(env.return_deposit(&crank, K, ID, &u.pubkey()), "CohortNotEnded");
        for k in [env.admin.insecure_clone(), env.creator.insecure_clone(), env.attester.insecure_clone(), env.user(0)] {
            expect_err(env.return_deposit(&k, K, ID, &u.pubkey()), "CohortNotEnded");
        }
    }
    assert_eq!(env.token_amount(&skr_vault_pda(&cohort_pda(K, ID))), DEPOSIT);
}

#[test]
fn only_the_crank_returns_between_end_and_deadline() {
    let (mut env, users, start) = joined(2);
    env.set_time(start + 3 * DAY);
    for k in [env.admin.insecure_clone(), env.creator.insecure_clone(), env.attester.insecure_clone(), env.user(0)] {
        expect_err(env.return_deposit(&k, K, ID, &users[0].pubkey()), "CohortNotEnded");
    }
    let crank = env.crank.insecure_clone();
    ok(env.return_deposit(&crank, K, ID, &users[0].pubkey()));
    env.set_time(start + 8 * DAY - 1);
    let stranger = env.user(0);
    expect_err(env.return_deposit(&stranger, K, ID, &users[1].pubkey()), "CohortNotEnded");
    env.set_time(start + 8 * DAY);
    ok(env.return_deposit(&stranger, K, ID, &users[1].pubkey()));
    for u in &users {
        assert_eq!(env.token_amount(&env.skr_ata(&u.pubkey())), DEPOSIT);
    }
}

// ---- deposits go only to their depositor ----------------------------------------------------------

#[test]
fn skr_goes_only_to_the_depositor() {
    let (mut env, users, start) = joined(2);
    let (victim, other) = (&users[0], &users[1]);
    env.set_time(start + 8 * DAY);
    let thief = env.user(0);
    let thief_ata = env.skr_ata(&thief.pubkey());
    env.set_token_amount(thief_ata, SKR_MINT, thief.pubkey(), 0);

    // Return aimed at the thief's account while naming the victim.
    // (Anchor 2015 ConstraintTokenOwner: the account is not owned by the named depositor.)
    let ix = env.return_ix(&thief.pubkey(), K, ID, victim.pubkey(), thief_ata);
    expect_err(env.send(&[ix], &[&thief]), "Custom(2015)");
    // A non-ATA account owned by the victim is refused too: the destination must be their ATA.
    let side = Pubkey::new_unique();
    env.set_token_amount(side, SKR_MINT, victim.pubkey(), 0);
    let ix = env.return_ix(&thief.pubkey(), K, ID, victim.pubkey(), side);
    assert!(env.send(&[ix], &[&thief]).is_err());
    assert_eq!(env.token_amount(&side), 0);
    // Naming the thief as depositor: not a participant.
    let ix = env.return_ix(&thief.pubkey(), K, ID, thief.pubkey(), thief_ata);
    expect_err(env.send(&[ix], &[&thief]), "NotParticipant");
    // Withdraw by a non-participant.
    expect_err(env.withdraw(&thief, K, ID), "NotParticipant");
    // A participant withdrawing into someone else's account.
    let ix = env.withdraw_ix(&other.pubkey(), K, ID, env.skr_ata(&victim.pubkey()));
    expect_err(env.send(&[ix], &[other]), "ConstraintTokenOwner");

    assert_eq!(env.token_amount(&thief_ata), 0);
    ok(env.withdraw(victim, K, ID));
    expect_err(env.withdraw(victim, K, ID), "AlreadyReturned");
    let crank = env.crank.insecure_clone();
    expect_err(env.return_deposit(&crank, K, ID, &victim.pubkey()), "AlreadyReturned");
    assert_eq!(env.token_amount(&env.skr_ata(&victim.pubkey())), DEPOSIT);
}

// ---- success, pick, settle ------------------------------------------------------------------------

#[test]
fn mark_success_guards() {
    let (mut env, users, start) = joined(1);
    let u = users[0].pubkey();
    env.set_time(start + 2 * DAY - 1);
    expect_err(env.mark_success(K, ID, &u), "SuccessWindowClosed");
    env.set_time(start + 2 * DAY);
    for k in [env.crank.insecure_clone(), env.creator.insecure_clone(), env.admin.insecure_clone(), users[0].insecure_clone()] {
        let ix = env.mark_success_ix(&k.pubkey(), K, ID, u);
        expect_err(env.send(&[ix], &[&k]), "Unauthorized");
    }
    expect_err(env.mark_success(K, ID, &Pubkey::new_unique()), "NotParticipant");
    env.set_time(start + 8 * DAY);
    expect_err(env.mark_success(K, ID, &u), "SuccessWindowClosed");
    env.set_time(start + 8 * DAY - 1);
    ok(env.mark_success(K, ID, &u));
}

#[test]
fn pick_guards() {
    let (mut env, users, start) = joined(2);
    let (a, b) = (&users[0], &users[1]);
    env.set_time(start + 2 * DAY);
    expect_err(env.pick(a, K, ID, 3), "NotSuccessful");
    ok(env.mark_success(K, ID, &a.pubkey()));
    ok(env.mark_success(K, ID, &b.pubkey()));
    expect_err(env.pick(a, K, ID, 25), "InvalidSquare");

    // A fake board elsewhere, and the real address with the wrong owner.
    let fake = Pubkey::new_unique();
    let data = fixture_data(&fixture("board"));
    env.set_raw(fake, ORE_PROGRAM_ID, data.clone());
    let ix = env.pick_ix(&a.pubkey(), K, ID, 3, fake);
    expect_err(env.send(&[ix], &[a]), "InvalidBoard");
    env.set_raw(ORE_BOARD, Pubkey::new_unique(), data);
    expect_err(env.pick(a, K, ID, 3), "InvalidBoard");
    env.set_board(10);

    ok(env.pick(a, K, ID, 3));
    expect_err(env.pick(a, K, ID, 4), "AlreadyPicked");
    env.set_time(start + 8 * DAY);
    expect_err(env.pick(b, K, ID, 4), "DeadlinePassed");
}

#[test]
fn settle_rejects_forged_rounds_and_keeps_order() {
    let (mut env, users, start) = joined(2);
    let (a, b) = (&users[0], &users[1]);
    env.set_time(start + 2 * DAY);
    for u in [a, b] {
        ok(env.mark_success(K, ID, &u.pubkey()));
    }
    let payer = env.user(0);
    expect_err(env.settle_next(&payer, K, ID), "NotPicked");
    env.set_board(100);
    ok(env.pick(a, K, ID, 1)); // targets 101
    env.set_board(110);
    ok(env.pick(b, K, ID, 1)); // targets 111

    // b's round is revealed first; a's is not (board rewound to 101: a's round is live). Order holds.
    env.set_round(111, Some(rng_for(1, true)));
    env.set_round(101, None);
    env.set_board(101);
    expect_err(env.settle_next(&payer, K, ID), "RoundNotRevealed");
    let ix = env.settle_ix(K, ID, locked_in::ore::round_address(111));
    expect_err(env.send(&[ix], &[&payer]), "InvalidRound");

    // Forgeries of a's round while ORE has not moved past it: a foreign-owned account at the right
    // address is "not available", a wrong id inside or a wrong size is rejected outright.
    let r101 = locked_in::ore::round_address(101);
    let mut data = fixture_data(&fixture("round_417350"));
    data[8..16].copy_from_slice(&101u64.to_le_bytes());
    let rng = rng_for(1, true).to_le_bytes();
    data[616..624].copy_from_slice(&rng);
    env.set_raw(r101, Pubkey::new_unique(), data.clone());
    expect_err(env.settle_next(&payer, K, ID), "RoundNotRevealed");
    let mut wrong_id = data.clone();
    wrong_id[8..16].copy_from_slice(&111u64.to_le_bytes());
    env.set_raw(r101, ORE_PROGRAM_ID, wrong_id.clone());
    expect_err(env.settle_next(&payer, K, ID), "InvalidRound");
    let mut short = data.clone();
    short.truncate(900);
    env.set_raw(r101, ORE_PROGRAM_ID, short.clone());
    expect_err(env.settle_next(&payer, K, ID), "InvalidRound");
    // Still rejected once ORE is past it: a malformed ORE-owned account never reads as "closed".
    env.set_board(112);
    env.set_raw(r101, ORE_PROGRAM_ID, wrong_id);
    expect_err(env.settle_next(&payer, K, ID), "InvalidRound");
    env.set_raw(r101, ORE_PROGRAM_ID, short);
    expect_err(env.settle_next(&payer, K, ID), "InvalidRound");

    // Genuine: a Legendary, then b (same motherlode) capped to Rare.
    env.set_round(101, Some(rng_for(1, true)));
    ok(env.settle_next(&payer, K, ID));
    ok(env.settle_next(&payer, K, ID));
    assert_eq!(env.slot_of(K, ID, &a.pubkey()).tier, TIER_LEGENDARY);
    assert_eq!(env.slot_of(K, ID, &b.pubkey()).tier, TIER_RARE);
    expect_err(env.settle_next(&payer, K, ID), "NotPicked");
}

// ---- claim ----------------------------------------------------------------------------------------

#[test]
fn claim_guards_and_expiry() {
    let (mut env, users, start) = joined(3);
    let (a, b, c) = (&users[0], &users[1], &users[2]);
    env.set_time(start + 2 * DAY);
    for u in [a, b] {
        ok(env.mark_success(K, ID, &u.pubkey()));
    }
    env.set_board(10);
    ok(env.pick(a, K, ID, 0));
    expect_err(env.claim(a, K, ID), "NotSettled");
    expect_err(env.claim(c, K, ID), "NotSettled");
    ok(env.pick(b, K, ID, 0));
    env.set_round(11, Some(rng_for(4, false)));
    let payer = env.user(0);
    ok(env.settle_next(&payer, K, ID));
    ok(env.settle_next(&payer, K, ID));

    // Someone else claiming, or a participant claiming into another's ORE account.
    let thief = env.user(0);
    expect_err(env.claim(&thief, K, ID), "NotParticipant");
    ok(env.claim(a, K, ID));
    // Now that a's ORE account exists, b cannot route a claim into it (Anchor 2015 ConstraintTokenOwner).
    let ix = env.claim_ix(&b.pubkey(), K, ID, env.ore_ata(&a.pubkey()));
    expect_err(env.send(&[ix], &[b]), "Custom(2015)");
    expect_err(env.claim(a, K, ID), "AlreadyClaimed");

    // b never claims: after the deadline the reward is gone and the reservation is released.
    env.set_time(start + 8 * DAY);
    expect_err(env.claim(b, K, ID), "DeadlinePassed");
    let crank = env.crank.insecure_clone();
    for u in [a, b, c] {
        ok(env.return_deposit(&crank, K, ID, &u.pubkey()));
    }
    let vault_before = env.token_amount(&reward_vault_pda());
    ok(env.close(&payer, K, ID));
    assert_eq!(env.config().reserved_total, 0);
    assert_eq!(env.token_amount(&reward_vault_pda()), vault_before, "expiry moves no ORE");
    assert_eq!(env.token_amount(&env.ore_ata(&a.pubkey())), COMMON);
}

// ---- close ----------------------------------------------------------------------------------------

#[test]
fn close_guards() {
    let (mut env, users, start) = joined(2);
    let payer = env.user(0);
    env.set_time(start + 8 * DAY - 1);
    expect_err(env.close(&payer, K, ID), "DeadlineNotPassed");
    env.set_time(start + 8 * DAY);
    let crank = env.crank.insecure_clone();
    ok(env.return_deposit(&crank, K, ID, &users[0].pubkey()));
    expect_err(env.close(&payer, K, ID), "DepositsOutstanding");
    ok(env.return_deposit(&crank, K, ID, &users[1].pubkey()));
    // Rent can only go to the recorded creator.
    let ix = env.close_ix(K, ID, payer.pubkey());
    expect_err(env.send(&[ix], &[&payer]), "Unauthorized");
    ok(env.close(&payer, K, ID));
}
