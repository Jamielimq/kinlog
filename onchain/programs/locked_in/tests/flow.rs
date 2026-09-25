//! End-to-end paths through a cohort's life.
mod common;

use common::*;
use locked_in::{constants::*, state::*};
use solana_signer::Signer;

const K: u8 = KIND_3_DAY;
const ID: u32 = 20261004;

/// Cohort created, `n` users joined, clock at the start of the last day.
fn cohort_at_last_day(n: usize) -> (Env, Vec<solana_keypair::Keypair>, i64) {
    let mut env = Env::ready(ORE);
    let start = env.create_real_cohort(K, ID);
    env.set_time(start - 3600);
    let users = env.join_many(K, ID, n);
    env.set_time(start + 2 * DAY + 10);
    (env, users, start)
}

#[test]
fn full_lifecycle() {
    let mut env = Env::ready(ORE);
    let start = env.create_real_cohort(K, ID);
    let c = env.cohort(K, ID);
    assert_eq!(c.start_ts, start);
    assert_eq!(c.end_ts, start + 3 * DAY);
    assert_eq!(c.deadline_ts, start + 8 * DAY);
    assert_eq!(c.capacity, 30);
    assert_eq!(c.reserved, COMMON * 52);
    assert_eq!(env.config().reserved_total, COMMON * 52);
    assert_eq!(env.config().live_cohorts, [1, 0]);

    // Early deposit, before the start.
    env.set_time(start - 3600);
    let alice = env.user(DEPOSIT);
    let fee_before = env.lamports(&env.fee_wallet);
    let meta = ok(env.deposit(&alice, K, ID));
    println!("deposit CU {}", meta.compute_units_consumed);
    assert_eq!(env.token_amount(&env.skr_ata(&alice.pubkey())), 0);
    assert_eq!(env.token_amount(&skr_vault_pda(&cohort_pda(K, ID))), DEPOSIT);
    assert_eq!(env.lamports(&env.fee_wallet) - fee_before, FEE);

    // Success on the last day, then pick. Target = board round + 1, read on-chain.
    env.set_time(start + 2 * DAY + 60);
    ok(env.mark_success(K, ID, &alice.pubkey()));
    env.set_board(500);
    let meta = ok(env.pick(&alice, K, ID, 7));
    println!("pick CU {}", meta.compute_units_consumed);
    let s = env.slot_of(K, ID, &alice.pubkey());
    assert_eq!((s.square, s.target_round, s.pick_seq), (7, 501, 0));

    // Round 501 not revealed yet -> settle refuses; revealed with square 7 -> Rare.
    env.set_round(501, None);
    let crank = env.crank.insecure_clone();
    expect_err(env.settle_next(&crank, K, ID), "RoundNotRevealed");
    env.set_round(501, Some(rng_for(7, false)));
    let meta = ok(env.settle_next(&crank, K, ID));
    println!("settle CU {}", meta.compute_units_consumed);
    assert!(meta.logs.iter().any(|l| l.contains("Locked In settle: round 501 reason revealed winning_square 7 picked 7 motherlode false tier 2")));
    let s = env.slot_of(K, ID, &alice.pubkey());
    assert_eq!((s.tier, s.amount), (TIER_RARE, COMMON * 2));

    // Claim creates the ORE ATA (user pays its rent) and moves exactly the amount.
    let vault_before = env.token_amount(&reward_vault_pda());
    let meta = ok(env.claim(&alice, K, ID));
    println!("claim CU {}", meta.compute_units_consumed);
    assert_eq!(env.token_amount(&env.ore_ata(&alice.pubkey())), COMMON * 2);
    assert_eq!(vault_before - env.token_amount(&reward_vault_pda()), COMMON * 2);
    assert_eq!(env.config().reserved_total, COMMON * 52 - COMMON * 2);

    // After the end: withdraw. The slot stays.
    env.set_time(start + 3 * DAY);
    ok(env.withdraw(&alice, K, ID));
    assert_eq!(env.token_amount(&env.skr_ata(&alice.pubkey())), DEPOSIT);
    let s = env.slot_of(K, ID, &alice.pubkey());
    assert!(s.has(FLAG_RETURNED) && s.has(FLAG_CLAIMED) && s.tier == TIER_RARE);

    // Deadline: anyone closes; rent goes to the creator; reservation released.
    env.set_time(start + 8 * DAY);
    let stranger = env.user(0);
    let creator_before = env.lamports(&env.creator.pubkey());
    let cohort_rent = env.lamports(&cohort_pda(K, ID)) + env.lamports(&skr_vault_pda(&cohort_pda(K, ID)));
    ok(env.close(&stranger, K, ID));
    assert!(!env.exists(&cohort_pda(K, ID)));
    assert!(!env.exists(&skr_vault_pda(&cohort_pda(K, ID))));
    assert_eq!(env.lamports(&env.creator.pubkey()) - creator_before, cohort_rent);
    assert_eq!(env.config().reserved_total, 0);
    assert_eq!(env.config().live_cohorts, [0, 0]);
    println!("cohort + vault rent (LiteSVM rent) {cohort_rent} lamports, cohort account {} bytes", Cohort::SPACE);
}

#[test]
fn mainnet_fixture_rounds_settle_to_expected_tiers() {
    // Each mainnet round decides one user's pick; tiers must follow ORE's own record.
    let rounds = [417150u64, 417346, 417347, 417348, 417349, 417350];
    let (mut env, users, _) = cohort_at_last_day(rounds.len());
    let crank = env.crank.insecure_clone();
    for (u, id) in users.iter().zip(rounds) {
        ok(env.mark_success(K, ID, &u.pubkey()));
        let v = env.set_fixture_round(id);
        let win = v["expected"]["winning_square"].as_u64().unwrap() as u8;
        env.set_board(id - 1);
        // Odd rounds: pick the winning square; even: miss it.
        let square = if id % 2 == 1 { win } else { (win + 1) % 25 };
        ok(env.pick(u, K, ID, square));
        ok(env.settle_next(&crank, K, ID));
        let s = env.slot_of(K, ID, &u.pubkey());
        let expected = if v["expected"]["motherlode_hit"].as_bool().unwrap() {
            TIER_LEGENDARY
        } else if square == win {
            TIER_RARE
        } else {
            TIER_COMMON
        };
        assert_eq!(s.tier, expected, "round {id}");
    }
}

#[test]
fn caps_downgrade_in_pick_order_when_rounds_crowd() {
    // Six picks on the same motherlode round, all on its winning square.
    let (mut env, users, _) = cohort_at_last_day(6);
    let crank = env.crank.insecure_clone();
    env.set_board(900);
    for u in &users {
        ok(env.mark_success(K, ID, &u.pubkey()));
        ok(env.pick(u, K, ID, 3));
    }
    env.set_round(901, Some(rng_for(3, true)));
    for _ in 0..users.len() {
        ok(env.settle_next(&crank, K, ID));
    }
    let tiers: Vec<u8> = users.iter().map(|u| env.slot_of(K, ID, &u.pubkey()).tier).collect();
    // 1 Legendary, then the Legendary overflow and the next two take the 3 Rare seats, rest Common.
    assert_eq!(tiers, vec![TIER_LEGENDARY, TIER_RARE, TIER_RARE, TIER_RARE, TIER_COMMON, TIER_COMMON]);
    let c = env.cohort(K, ID);
    assert_eq!((c.legendary_awarded, c.rare_awarded), (1, 3));
    let paid: u64 = users.iter().map(|u| env.slot_of(K, ID, &u.pubkey()).amount).sum();
    assert_eq!(paid, COMMON * (20 + 2 * 3 + 2));
}

#[test]
fn settlement_is_caller_independent() {
    let run = |use_stranger: bool| {
        let (mut env, users, _) = cohort_at_last_day(3);
        env.set_board(40);
        for (i, u) in users.iter().enumerate() {
            ok(env.mark_success(K, ID, &u.pubkey()));
            ok(env.pick(u, K, ID, [5, 9, 5][i]));
        }
        env.set_round(41, Some(rng_for(5, false)));
        let caller = if use_stranger { env.user(0) } else { env.crank.insecure_clone() };
        for _ in 0..3 {
            ok(env.settle_next(&caller, K, ID));
        }
        users
            .iter()
            .map(|u| {
                let s = env.slot_of(K, ID, &u.pubkey());
                (s.tier, s.amount)
            })
            .collect::<Vec<_>>()
    };
    let a = run(false);
    assert_eq!(a, run(true));
    assert_eq!(a[0].0, TIER_RARE);
    assert_eq!(a[1].0, TIER_COMMON);
    assert_eq!(a[2].0, TIER_RARE);
}

#[test]
fn unusable_rounds_retarget_closed_rounds_pay_common() {
    let (mut env, users, _) = cohort_at_last_day(2);
    let (a, b) = (&users[0], &users[1]);
    let payer = env.user(0);
    let crank = env.crank.insecure_clone();
    for u in [a, b] {
        ok(env.mark_success(K, ID, &u.pubkey()));
    }
    env.set_board(700);
    ok(env.pick(a, K, ID, 1)); // targets 701
    ok(env.pick(b, K, ID, 1)); // targets 701
    let r701 = locked_in::ore::round_address(701);

    // Not revealed yet (board still on 700, round 701 not created): settle and retarget both refuse.
    expect_err(env.settle_next(&crank, K, ID), "RoundNotRevealed");
    let ix = env.retarget_ix(K, ID, a.pubkey(), r701);
    expect_err(env.send(&[ix], &[&payer]), "RetargetNotAllowed");
    // Created but not revealed (board on 701): same.
    env.set_board(701);
    env.set_round(701, None);
    expect_err(env.settle_next(&crank, K, ID), "RoundNotRevealed");
    let ix = env.retarget_ix(K, ID, a.pubkey(), r701);
    expect_err(env.send(&[ix], &[&payer]), "RetargetNotAllowed");

    // Finished without entropy (board past it, slot hash all 0xFF): settle refuses, retarget moves it.
    env.set_board(705);
    let mut acc = env.svm.get_account(&r701).unwrap();
    acc.data[616..648].copy_from_slice(&[0xFF; 32]);
    env.svm.set_account(r701, acc).unwrap();
    expect_err(env.settle_next(&crank, K, ID), "RoundNeedsRetarget");
    let ix = env.retarget_ix(K, ID, a.pubkey(), r701);
    let meta = ok(env.send(&[ix], &[&payer]));
    assert!(meta.logs.iter().any(|l| l.contains("Locked In retarget: round 701 finished without entropy, new target 706")));
    let s = env.slot_of(K, ID, &a.pubkey());
    assert_eq!((s.target_round, s.pick_seq), (706, 0));

    // A revealed round cannot be retargeted.
    env.set_board(800);
    env.set_round(706, Some(rng_for(1, true)));
    let ix = env.retarget_ix(K, ID, a.pubkey(), locked_in::ore::round_address(706));
    expect_err(env.send(&[ix], &[&payer]), "RetargetNotAllowed");

    // A closed round cannot be retargeted either; it settles as Common.
    env.remove(locked_in::ore::round_address(706));
    let ix = env.retarget_ix(K, ID, a.pubkey(), locked_in::ore::round_address(706));
    expect_err(env.send(&[ix], &[&payer]), "RetargetNotAllowed");
    let meta = ok(env.settle_next(&crank, K, ID));
    assert!(meta.logs.iter().any(|l| l.contains("Locked In settle: round 706 reason round_closed winning_square 255 picked 1 motherlode false tier 1")));
    let s = env.slot_of(K, ID, &a.pubkey());
    assert_eq!((s.tier, s.amount), (TIER_COMMON, COMMON));
    assert_eq!(env.cohort(K, ID).legendary_awarded, 0);

    // b still targets 701 (no entropy, board past it). A fake empty account cannot stand in for
    // its round: the address must be the round's PDA.
    let fake = solana_keypair::Keypair::new().pubkey();
    let ix = env.settle_ix(K, ID, fake);
    expect_err(env.send(&[ix], &[&crank]), "InvalidRound");
    let ix = env.retarget_ix(K, ID, b.pubkey(), fake);
    expect_err(env.send(&[ix], &[&payer]), "InvalidRound");
    let ix = env.retarget_ix(K, ID, b.pubkey(), r701);
    ok(env.send(&[ix], &[&payer]));
    env.set_round(801, Some(rng_for(1, false)));
    ok(env.settle_next(&crank, K, ID));
    assert_eq!(env.slot_of(K, ID, &b.pubkey()).tier, TIER_RARE);
}

#[test]
fn closed_round_is_common_only_once_ore_moved_past_it() {
    // An empty PDA for a round ORE has not reached yet must not be read as "closed".
    let (mut env, users, _) = cohort_at_last_day(1);
    let u = &users[0];
    ok(env.mark_success(K, ID, &u.pubkey()));
    env.set_board(50);
    ok(env.pick(u, K, ID, 9)); // targets 51, which does not exist yet
    let crank = env.crank.insecure_clone();
    expect_err(env.settle_next(&crank, K, ID), "RoundNotRevealed");
    env.set_board(51); // round 51 is the live round now; its PDA still empty here
    expect_err(env.settle_next(&crank, K, ID), "RoundNotRevealed");
    env.set_board(52); // ORE moved past 51 and its account is gone
    ok(env.settle_next(&crank, K, ID));
    assert_eq!(env.slot_of(K, ID, &u.pubkey()).tier, TIER_COMMON);
}

#[test]
fn test_cohort_with_short_days_any_start() {
    let mut env = Env::ready(ORE);
    let admin = env.admin.insecure_clone();
    let mut limits = Env::default_limits();
    limits.min_day_seconds = 600;
    let ix = env.admin_ix(&admin.pubkey(), anchor_lang::InstructionData::data(&locked_in::instruction::SetLimits { limits }));
    ok(env.send(&[ix], &[&admin]));

    let creator = env.creator.insecure_clone();
    let start = env.now + 123; // not on the 15:00 UTC boundary
    let ix = env.create_cohort_ix(&creator.pubkey(), K, 1, start, 600, SKR, COMMON);
    ok(env.send(&[ix], &[&creator]));
    let c = env.cohort(K, 1);
    assert_eq!((c.end_ts, c.deadline_ts), (start + 1800, start + 1800 + 3000));

    // A 600 s day still cannot claim to be a real day off the boundary, and 86,400 s must align.
    let ix = env.create_cohort_ix(&creator.pubkey(), K, 2, start, DAY as u32, SKR, COMMON);
    expect_err(env.send(&[ix], &[&creator]), "MisalignedStart");
}

#[test]
fn closed_ata_is_recreated_on_return_and_dust_is_burned() {
    let (mut env, users, start) = cohort_at_last_day(2);
    let (a, b) = (&users[0], &users[1]);
    // `a` closed their SKR account; a stranger returns after the deadline and pays to recreate it.
    env.remove(env.skr_ata(&a.pubkey()));
    // Someone sends dust into the vault.
    let vault = skr_vault_pda(&cohort_pda(K, ID));
    let cohort = cohort_pda(K, ID);
    env.set_token_amount(vault, SKR_MINT, cohort, 2 * DEPOSIT + 7);

    env.set_time(start + 8 * DAY);
    let stranger = env.user(0);
    ok(env.return_deposit(&stranger, K, ID, &a.pubkey()));
    ok(env.return_deposit(&stranger, K, ID, &b.pubkey()));
    assert_eq!(env.token_amount(&env.skr_ata(&a.pubkey())), DEPOSIT);
    assert_eq!(env.token_amount(&vault), 7);
    let supply = |env: &Env| u64::from_le_bytes(env.svm.get_account(&SKR_MINT).unwrap().data[36..44].try_into().unwrap());
    let supply_before = supply(&env);
    ok(env.close(&stranger, K, ID));
    assert!(!env.exists(&vault));
    assert_eq!(supply_before - supply(&env), 7, "dust burned, not sent anywhere");
}
