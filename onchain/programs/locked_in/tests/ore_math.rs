//! The ported ORE math, checked against round accounts captured from mainnet.
mod common;

use common::*;
use locked_in::ore;

fn slot_hash(v: &serde_json::Value) -> [u8; 32] {
    let d = fixture_data(v);
    d[616..648].try_into().unwrap()
}

/// Every captured round whose expected result came from ORE's own ResetEvent (reset transaction
/// signature recorded in the fixture) must be reproduced by the ported math.
#[test]
fn mainnet_rounds_match_ore_reset_events() {
    let dir = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    let mut checked = 0;
    let mut motherlodes = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        let Some(id) = name.strip_prefix("round_").and_then(|n| n.strip_suffix(".json")) else { continue };
        let v = fixture(&format!("round_{id}"));
        if v.get("expected_source").is_none() {
            continue;
        }
        let id: u64 = id.parse().unwrap();
        let d = fixture_data(&v);
        assert_eq!(d.len(), ore::ROUND_LEN, "round {id} size");
        assert_eq!(d[0], ore::ROUND_DISCRIMINATOR, "round {id} discriminator");
        assert_eq!(u64::from_le_bytes(d[8..16].try_into().unwrap()), id);
        let rng = ore::rng(&slot_hash(&v)).expect("revealed");
        let src = &v["expected_source"];
        assert!(src["reset_tx"].as_str().unwrap().len() > 60, "round {id} source signature");
        assert_eq!(rng.to_string(), src["event_rng"].as_str().unwrap(), "round {id} rng");
        assert_eq!(
            ore::winning_square(rng) as u64,
            v["expected"]["winning_square"].as_u64().unwrap(),
            "round {id} winning square"
        );
        let ml = ore::hit_motherlode(rng);
        assert_eq!(ml, v["expected"]["motherlode_hit"].as_bool().unwrap(), "round {id} motherlode");
        motherlodes += ml as u32;
        checked += 1;
    }
    assert!(checked >= 27, "only {checked} event-sourced fixtures");
    assert_eq!(motherlodes, 3);
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
