//! The ported ORE math, checked against round accounts captured from mainnet.
mod common;

use common::*;
use locked_in::ore;

fn slot_hash(v: &serde_json::Value) -> [u8; 32] {
    let d = fixture_data(v);
    d[616..648].try_into().unwrap()
}

#[test]
fn mainnet_rounds_match_recorded_results() {
    // Three motherlode rounds plus ordinary ones. `motherlode_field` is what ORE itself wrote.
    for id in [416426u64, 416738, 417150, 417346, 417347, 417348, 417349, 417350] {
        let v = fixture(&format!("round_{id}"));
        let d = fixture_data(&v);
        assert_eq!(d.len(), ore::ROUND_LEN, "round {id} size");
        assert_eq!(d[0], ore::ROUND_DISCRIMINATOR, "round {id} discriminator");
        assert_eq!(u64::from_le_bytes(d[8..16].try_into().unwrap()), id);
        let rng = ore::rng(&slot_hash(&v)).expect("revealed");
        let recorded_motherlode: u64 = v["expected"]["motherlode_field"].as_str().unwrap().parse().unwrap();
        assert_eq!(ore::hit_motherlode(rng), recorded_motherlode > 0, "round {id} motherlode");
        assert_eq!(
            ore::winning_square(rng) as u64,
            v["expected"]["winning_square"].as_u64().unwrap(),
            "round {id} winning square"
        );
    }
}

#[test]
fn unrevealed_round_has_no_rng() {
    let v = fixture("round_417351");
    assert!(ore::rng(&slot_hash(&v)).is_none());
    assert!(ore::rng(&[0xFF; 32]).is_none());
}

#[test]
fn board_fixture_layout() {
    let d = fixture_data(&fixture("board"));
    assert_eq!(d.len(), ore::BOARD_LEN);
    assert_eq!(d[0], ore::BOARD_DISCRIMINATOR);
}

#[test]
fn rng_helper_produces_requested_results() {
    for sq in 0..25u8 {
        for ml in [false, true] {
            let r = rng_for(sq, ml);
            assert_eq!(ore::winning_square(r), sq);
            assert_eq!(ore::hit_motherlode(r), ml);
        }
    }
}
