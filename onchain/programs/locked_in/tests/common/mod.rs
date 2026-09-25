//! Shared LiteSVM harness for the Locked In tests.
#![allow(dead_code)]

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{bpf_loader_upgradeable, instruction::Instruction, system_program},
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use base64::Engine;
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use locked_in::{constants::*, state::*};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub const SKR: u64 = 1_000_000; // 1 SKR in raw units
pub const ORE: u64 = 100_000_000_000; // 1 ORE in raw units
pub const DEPOSIT: u64 = 100 * SKR;
pub const COMMON: u64 = 164_000_000; // 0.00164 ORE
pub const FEE: u64 = 1_000_000; // 0.001 SOL
pub const DAY: i64 = 86_400;
pub const MAX_REWARD_PER_BOX: u64 = 5 * ORE / 100; // 0.05 ORE

pub type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

pub struct Env {
    pub svm: LiteSVM,
    pub deployer: Keypair,
    pub admin: Keypair,
    pub creator: Keypair,
    pub attester: Keypair,
    pub crank: Keypair,
    pub fee_wallet: Pubkey,
    pub now: i64,
    pub slot: u64,
}

pub fn fixture(name: &str) -> serde_json::Value {
    let path = format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn fixture_data(v: &serde_json::Value) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(v["data_base64"].as_str().unwrap())
        .unwrap()
}

pub fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &locked_in::ID).0
}
pub fn reward_vault_pda() -> Pubkey {
    Pubkey::find_program_address(&[REWARD_VAULT_SEED], &locked_in::ID).0
}
pub fn cohort_pda(kind: u8, id: u32) -> Pubkey {
    Pubkey::find_program_address(&[COHORT_SEED, &[kind], &id.to_le_bytes()], &locked_in::ID).0
}
pub fn skr_vault_pda(cohort: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[SKR_VAULT_SEED, cohort.as_ref()], &locked_in::ID).0
}

fn pack_mint(decimals: u8, supply: u64) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    // mint_authority: COption::None (4 zero bytes + 32), supply, decimals, is_initialized
    d[36..44].copy_from_slice(&supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}

pub fn pack_token_account(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

/// Next 15:00 UTC strictly after `ts`.
pub fn next_aligned_start(ts: i64) -> i64 {
    let base = ts - ts.rem_euclid(DAY) + REAL_COHORT_START_OFFSET;
    if base > ts {
        base
    } else {
        base + DAY
    }
}

/// An rng whose ORE result is the given square, with or without a motherlode.
pub fn rng_for(square: u8, motherlode: bool) -> u64 {
    (1u64..)
        .map(|k| {
            if motherlode {
                (k * 500).reverse_bits()
            } else {
                k.wrapping_mul(0x9E37_79B9_7F4A_7C15)
            }
        })
        .find(|r| {
            locked_in::ore::winning_square(*r) == square
                && locked_in::ore::hit_motherlode(*r) == motherlode
        })
        .unwrap()
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new().with_transaction_history(0);
        let bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../target/deploy/locked_in.so"
        ));
        svm.add_program(locked_in::ID, bytes).unwrap();

        let deployer = Keypair::new();
        // LiteSVM deploys with no upgrade authority; give it one so init_config can check it.
        let pd = bpf_loader_upgradeable::get_program_data_address(&locked_in::ID);
        let mut acc = svm.get_account(&pd).unwrap();
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(deployer.pubkey().as_ref());
        svm.set_account(pd, acc).unwrap();

        let mut env = Env {
            svm,
            deployer,
            admin: Keypair::new(),
            creator: Keypair::new(),
            attester: Keypair::new(),
            crank: Keypair::new(),
            fee_wallet: Pubkey::new_unique(),
            now: 1_790_000_000,
            slot: 1_000,
        };
        for k in [&env.deployer, &env.admin, &env.creator, &env.attester, &env.crank] {
            env.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        env.set_raw(SKR_MINT, spl_token_id(), pack_mint(SKR_DECIMALS, 10_000_000_000 * SKR));
        env.set_raw(ORE_MINT, spl_token_id(), pack_mint(ORE_DECIMALS, 500_000 * ORE));
        env.set_time(env.now);
        env.set_board(417_349);
        env
    }

    /// Env with config initialised and the reward vault holding `vault_ore` raw ORE.
    pub fn ready(vault_ore: u64) -> Self {
        let mut env = Env::new();
        let deployer = env.deployer.insecure_clone();
        env.init_config(&deployer).expect("init_config");
        env.set_token_amount(reward_vault_pda(), ORE_MINT, config_pda(), vault_ore);
        env
    }

    pub fn set_raw(&mut self, address: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(
                address,
                Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    pub fn remove(&mut self, address: Pubkey) {
        self.svm
            .set_account(
                address,
                Account {
                    lamports: 0,
                    data: vec![],
                    owner: system_program::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
    }

    pub fn set_time(&mut self, ts: i64) {
        self.now = ts;
        self.slot += 1;
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp = ts;
        clock.slot = self.slot;
        self.svm.set_sysvar(&clock);
    }

    pub fn set_token_amount(&mut self, address: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        self.set_raw(address, spl_token_id(), pack_token_account(&mint, &owner, amount));
    }

    pub fn token_amount(&self, address: &Pubkey) -> u64 {
        let a = self.svm.get_account(address).expect("token account");
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    pub fn exists(&self, address: &Pubkey) -> bool {
        self.svm
            .get_account(address)
            .map(|a| a.lamports > 0)
            .unwrap_or(false)
    }

    pub fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm.get_account(address).map(|a| a.lamports).unwrap_or(0)
    }

    /// A funded wallet holding `skr` raw SKR in its associated token account.
    pub fn user(&mut self, skr: u64) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
        let ata = get_associated_token_address(&k.pubkey(), &SKR_MINT);
        self.set_token_amount(ata, SKR_MINT, k.pubkey(), skr);
        k
    }

    pub fn skr_ata(&self, owner: &Pubkey) -> Pubkey {
        get_associated_token_address(owner, &SKR_MINT)
    }
    pub fn ore_ata(&self, owner: &Pubkey) -> Pubkey {
        get_associated_token_address(owner, &ORE_MINT)
    }

    // ---- ORE accounts ----------------------------------------------------------------------------

    pub fn set_board(&mut self, round_id: u64) {
        let mut data = fixture_data(&fixture("board"));
        data[8..16].copy_from_slice(&round_id.to_le_bytes());
        self.set_raw(ORE_BOARD, ORE_PROGRAM_ID, data);
    }

    /// A round account at the real PDA for `id`, with entropy producing `rng` (None = not revealed).
    pub fn set_round(&mut self, id: u64, rng: Option<u64>) {
        let mut data = fixture_data(&fixture("round_417350"));
        data[8..16].copy_from_slice(&id.to_le_bytes());
        let mut hash = [0u8; 32];
        if let Some(r) = rng {
            hash[0..8].copy_from_slice(&r.to_le_bytes());
        }
        data[616..648].copy_from_slice(&hash);
        self.set_raw(locked_in::ore::round_address(id), ORE_PROGRAM_ID, data);
    }

    /// Installs a mainnet fixture round unchanged, at its own address.
    pub fn set_fixture_round(&mut self, id: u64) -> serde_json::Value {
        let v = fixture(&format!("round_{id}"));
        let addr: Pubkey = v["address"].as_str().unwrap().parse().unwrap();
        assert_eq!(addr, locked_in::ore::round_address(id));
        self.set_raw(addr, ORE_PROGRAM_ID, fixture_data(&v));
        v
    }

    // ---- transactions ----------------------------------------------------------------------------

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let payer = signers[0].pubkey();
        let blockhash = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &blockhash);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx)
    }

    pub fn cohort(&self, kind: u8, id: u32) -> Cohort {
        let a = self.svm.get_account(&cohort_pda(kind, id)).expect("cohort");
        bytemuck::pod_read_unaligned::<Cohort>(&a.data[8..8 + core::mem::size_of::<Cohort>()])
    }

    pub fn slot_of(&self, kind: u8, id: u32, user: &Pubkey) -> Slot {
        let c = self.cohort(kind, id);
        *c.slots.iter().find(|s| s.user == *user).expect("slot")
    }

    pub fn config(&self) -> Config {
        use anchor_lang::AccountDeserialize;
        let a = self.svm.get_account(&config_pda()).unwrap();
        Config::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    pub fn default_limits() -> locked_in::Limits {
        locked_in::Limits {
            fee_lamports: FEE,
            deposit_amount_max: 1_000 * SKR,
            max_reward_per_box: MAX_REWARD_PER_BOX,
            min_day_seconds: DAY as u32,
            max_capacity: 30,
            max_live_cohorts: [4, 3],
        }
    }

    pub fn init_config(&mut self, signer: &Keypair) -> TxResult {
        let ix = Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::InitConfig {
                admin: self.admin.pubkey(),
                fee_wallet: self.fee_wallet,
                roles: locked_in::Roles {
                    cohort_creator: self.creator.pubkey(),
                    attester: self.attester.pubkey(),
                    crank: self.crank.pubkey(),
                },
                limits: Self::default_limits(),
            }
            .data(),
            locked_in::accounts::InitConfig {
                authority: signer.pubkey(),
                program: locked_in::ID,
                program_data: bpf_loader_upgradeable::get_program_data_address(&locked_in::ID),
                config: config_pda(),
                ore_mint: ORE_MINT,
                reward_vault: reward_vault_pda(),
                token_program: spl_token_id(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        self.send(&[ix], &[signer])
    }

    pub fn admin_ix(&self, signer: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction::new_with_bytes(
            locked_in::ID,
            &data,
            locked_in::accounts::AdminOnly {
                admin: *signer,
                config: config_pda(),
            }
            .to_account_metas(None),
        )
    }

    pub fn create_cohort_ix(
        &self,
        signer: &Pubkey,
        kind: u8,
        id: u32,
        start_ts: i64,
        day_seconds: u32,
        deposit_amount: u64,
        common_amount: u64,
    ) -> Instruction {
        let cohort = cohort_pda(kind, id);
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::CreateCohort {
                kind,
                id,
                start_ts,
                day_seconds,
                deposit_amount,
                common_amount,
            }
            .data(),
            locked_in::accounts::CreateCohort {
                creator: *signer,
                config: config_pda(),
                cohort,
                skr_vault: skr_vault_pda(&cohort),
                skr_mint: SKR_MINT,
                reward_vault: reward_vault_pda(),
                token_program: spl_token_id(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Creates a real (86,400 s) cohort starting at the next 15:00 UTC.
    pub fn create_real_cohort(&mut self, kind: u8, id: u32) -> i64 {
        let start = next_aligned_start(self.now);
        let creator = self.creator.insecure_clone();
        let ix = self.create_cohort_ix(&creator.pubkey(), kind, id, start, DAY as u32, DEPOSIT, COMMON);
        self.send(&[ix], &[&creator]).expect("create_cohort");
        start
    }

    pub fn deposit_ix(&self, user: &Pubkey, kind: u8, id: u32, fee_wallet: Pubkey, user_skr: Pubkey) -> Instruction {
        let cohort = cohort_pda(kind, id);
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::Deposit {}.data(),
            locked_in::accounts::Deposit {
                user: *user,
                config: config_pda(),
                cohort,
                skr_vault: skr_vault_pda(&cohort),
                user_skr,
                skr_mint: SKR_MINT,
                fee_wallet,
                token_program: spl_token_id(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn deposit(&mut self, user: &Keypair, kind: u8, id: u32) -> TxResult {
        let ix = self.deposit_ix(&user.pubkey(), kind, id, self.fee_wallet, self.skr_ata(&user.pubkey()));
        self.send(&[ix], &[user])
    }

    pub fn withdraw_ix(&self, user: &Pubkey, kind: u8, id: u32, user_skr: Pubkey) -> Instruction {
        let cohort = cohort_pda(kind, id);
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::Withdraw {}.data(),
            locked_in::accounts::Withdraw {
                user: *user,
                cohort,
                skr_vault: skr_vault_pda(&cohort),
                user_skr,
                skr_mint: SKR_MINT,
                token_program: spl_token_id(),
            }
            .to_account_metas(None),
        )
    }

    pub fn withdraw(&mut self, user: &Keypair, kind: u8, id: u32) -> TxResult {
        let ix = self.withdraw_ix(&user.pubkey(), kind, id, self.skr_ata(&user.pubkey()));
        self.send(&[ix], &[user])
    }

    pub fn return_ix(&self, caller: &Pubkey, kind: u8, id: u32, depositor: Pubkey, depositor_skr: Pubkey) -> Instruction {
        let cohort = cohort_pda(kind, id);
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::ReturnDeposit {}.data(),
            locked_in::accounts::ReturnDeposit {
                caller: *caller,
                config: config_pda(),
                cohort,
                skr_vault: skr_vault_pda(&cohort),
                depositor,
                depositor_skr,
                skr_mint: SKR_MINT,
                token_program: spl_token_id(),
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn return_deposit(&mut self, caller: &Keypair, kind: u8, id: u32, depositor: &Pubkey) -> TxResult {
        let ix = self.return_ix(&caller.pubkey(), kind, id, *depositor, self.skr_ata(depositor));
        self.send(&[ix], &[caller])
    }

    pub fn mark_success_ix(&self, signer: &Pubkey, kind: u8, id: u32, user: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::MarkSuccess { user }.data(),
            locked_in::accounts::MarkSuccess {
                attester: *signer,
                config: config_pda(),
                cohort: cohort_pda(kind, id),
            }
            .to_account_metas(None),
        )
    }

    pub fn mark_success(&mut self, kind: u8, id: u32, user: &Pubkey) -> TxResult {
        let attester = self.attester.insecure_clone();
        let ix = self.mark_success_ix(&attester.pubkey(), kind, id, *user);
        self.send(&[ix], &[&attester])
    }

    pub fn pick_ix(&self, user: &Pubkey, kind: u8, id: u32, square: u8, board: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::PickSquare { square }.data(),
            locked_in::accounts::PickSquare {
                user: *user,
                cohort: cohort_pda(kind, id),
                ore_board: board,
            }
            .to_account_metas(None),
        )
    }

    pub fn pick(&mut self, user: &Keypair, kind: u8, id: u32, square: u8) -> TxResult {
        let ix = self.pick_ix(&user.pubkey(), kind, id, square, ORE_BOARD);
        self.send(&[ix], &[user])
    }

    pub fn settle_ix(&self, kind: u8, id: u32, round: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::Settle {}.data(),
            locked_in::accounts::Settle {
                cohort: cohort_pda(kind, id),
                ore_board: ORE_BOARD,
                ore_round: round,
            }
            .to_account_metas(None),
        )
    }

    /// Settles the next pick in order, reading the round its slot targets. `caller` pays the fee.
    pub fn settle_next(&mut self, caller: &Keypair, kind: u8, id: u32) -> TxResult {
        let c = self.cohort(kind, id);
        let target = c
            .slots
            .iter()
            .find(|s| s.has(FLAG_PICKED) && !s.has(FLAG_SETTLED) && s.pick_seq == c.next_settle)
            .map(|s| s.target_round)
            .unwrap_or(0);
        let ix = self.settle_ix(kind, id, locked_in::ore::round_address(target));
        self.send(&[ix], &[caller])
    }

    pub fn retarget_ix(&self, kind: u8, id: u32, user: Pubkey, round: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::Retarget { user }.data(),
            locked_in::accounts::Retarget {
                cohort: cohort_pda(kind, id),
                ore_board: ORE_BOARD,
                ore_round: round,
            }
            .to_account_metas(None),
        )
    }

    pub fn claim_ix(&self, user: &Pubkey, kind: u8, id: u32, user_ore: Pubkey) -> Instruction {
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::ClaimReward {}.data(),
            locked_in::accounts::ClaimReward {
                user: *user,
                config: config_pda(),
                cohort: cohort_pda(kind, id),
                reward_vault: reward_vault_pda(),
                user_ore,
                ore_mint: ORE_MINT,
                token_program: spl_token_id(),
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    pub fn claim(&mut self, user: &Keypair, kind: u8, id: u32) -> TxResult {
        let ix = self.claim_ix(&user.pubkey(), kind, id, self.ore_ata(&user.pubkey()));
        self.send(&[ix], &[user])
    }

    pub fn close_ix(&self, kind: u8, id: u32, creator: Pubkey) -> Instruction {
        let cohort = cohort_pda(kind, id);
        Instruction::new_with_bytes(
            locked_in::ID,
            &locked_in::instruction::CloseCohort {}.data(),
            locked_in::accounts::CloseCohort {
                config: config_pda(),
                cohort,
                creator,
                skr_vault: skr_vault_pda(&cohort),
                skr_mint: SKR_MINT,
                token_program: spl_token_id(),
            }
            .to_account_metas(None),
        )
    }

    pub fn close(&mut self, caller: &Keypair, kind: u8, id: u32) -> TxResult {
        let ix = self.close_ix(kind, id, self.creator.pubkey());
        self.send(&[ix], &[caller])
    }

    /// Joins `n` fresh users to a cohort that is open for deposits.
    pub fn join_many(&mut self, kind: u8, id: u32, n: usize) -> Vec<Keypair> {
        (0..n)
            .map(|_| {
                let u = self.user(DEPOSIT);
                self.deposit(&u, kind, id).expect("deposit");
                u
            })
            .collect()
    }
}

pub fn spl_token_id() -> Pubkey {
    anchor_spl::token::ID
}

/// Asserts the transaction failed and its logs mention `needle` (an Anchor error name, or a
/// program error string).
pub fn expect_err(res: TxResult, needle: &str) {
    match res {
        Ok(meta) => panic!("expected failure containing {needle:?}, got success; logs:\n{}", meta.logs.join("\n")),
        Err(f) => {
            let logs = f.meta.logs.join("\n");
            assert!(
                logs.contains(needle) || format!("{:?}", f.err).contains(needle),
                "expected {needle:?}; err {:?}; logs:\n{logs}",
                f.err
            );
        }
    }
}

pub fn ok(res: TxResult) -> TransactionMetadata {
    match res {
        Ok(m) => m,
        Err(f) => panic!("tx failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}
