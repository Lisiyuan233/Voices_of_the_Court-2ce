#![no_main]
//! 有界 text scanner fuzz target（实施计划 Task 5 步骤 4）。
//!
//! 同时喂给 identity scanner 与 extract skip-first visitor（带固定
//! participant 上下文）。关注：任意字节流下不 panic、所有上限生效、
//! 不产生无界内存增长。

use libfuzzer_sys::fuzz_target;

#[path = "../../src/error.rs"]
pub mod error;
#[path = "../../src/limits.rs"]
pub mod limits;
#[path = "../../src/protocol.rs"]
pub mod protocol;
#[path = "../../src/identity.rs"]
pub mod identity;
#[path = "../../src/extract/mod.rs"]
pub mod extract;

const SCAN_LIMITS: identity::ScanLimits = identity::ScanLimits {
    max_bytes: 1 << 20,
    max_nesting: 64,
    max_scalar: 4096,
};

fuzz_target!(|data: &[u8]| {
    let _ = identity::extract(
        std::io::Cursor::new(data),
        std::io::Cursor::new(data),
        SCAN_LIMITS,
    );

    let ctx = extract::ExtractionContext {
        participants: vec!["1001".to_string()],
        categories: vec![protocol::Category::Family, protocol::Category::Realm],
        game_date_numeric: None,
        game_date_display: None,
        snapshot_id: None,
        campaign_id: None,
        snapshot_sequence: None,
    };
    let limits = extract::ExtractionLimits {
        scan: SCAN_LIMITS,
        max_facts: 100,
        max_entities: 100,
        max_related_characters: 50,
    };
    let _ = extract::extract(std::io::Cursor::new(data), limits, &ctx);
});
