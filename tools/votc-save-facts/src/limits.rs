//! 编译时硬上限（实施计划 Task 5 步骤 1，**已冻结**）。
//!
//! 冻结值（与计划表格一致）：
//!
//! | 资源 | 硬上限 |
//! |---|---:|
//! | stdin request | 64 KiB |
//! | stdout | 2 MiB |
//! | stderr | 64 KiB（App 端 cap） |
//! | decompressed gamestate | 512 MiB（真实 modded 样本到手后可上调，走变更流程） |
//! | nesting depth | 512 |
//! | scalar | 64 KiB |
//! | facts | 500 |
//! | entities | 250 |
//! | related characters | 100 |
//! | wars | 0（首版） |
//!
//! App 请求只能把这些上限调低，不能调高；超出即按 invalid 请求处理。
//! 修改任何冻结值必须同步计划 Task 5 表格与 fixtures/README。

// 全集一次冻结；HARD_MAX_STDERR_BYTES / HARD_MAX_WARS 等暂无消费方。
#![allow(dead_code)]

/// stdin 请求最大字节数。
pub const HARD_MAX_STDIN_REQUEST_BYTES: usize = 64 * 1024;
/// stdout 响应最大字节数（JSON 文档 + 结尾一个换行）。
pub const HARD_MAX_STDOUT_BYTES: u64 = 2 * 1024 * 1024;
/// stderr 上限（App 端 cap，这里仅记录约定，sidecar 侧只写短固定消息）。
pub const HARD_MAX_STDERR_BYTES: u64 = 64 * 1024;
/// 解压后 gamestate 上限。
pub const HARD_MAX_DECOMPRESSED_BYTES: u64 = 512 * 1024 * 1024;
/// parser 嵌套深度上限。
pub const HARD_MAX_NESTING_DEPTH: u64 = 512;
/// 单个 scalar 上限。
pub const HARD_MAX_SCALAR_BYTES: u64 = 64 * 1024;
/// facts 上限。
pub const HARD_MAX_FACTS: u64 = 500;
/// entities 上限。
pub const HARD_MAX_ENTITIES: u64 = 250;
/// related characters / participantCharacterIds 上限。
pub const HARD_MAX_RELATED_CHARACTERS: usize = 100;
/// root `variables.list` 中 `votc_join_candidates` 全局列表条目上限
///（Plan C Task 2b 契约；超限整列表丢弃 + JOIN_CANDIDATES_INVALID warning）。
pub const HARD_MAX_JOIN_CANDIDATES: usize = 512;
/// wars 上限（首版为 0）。
pub const HARD_MAX_WARS: u64 = 0;
/// protocol v2 typed verification request limits.
pub const HARD_MAX_VERIFY_CHECKS: u64 = 64;
pub const HARD_MAX_VERIFY_CHARACTERS: u64 = 32;
pub const HARD_MAX_VERIFY_OUTPUT_BYTES: u64 = 262_144;

// ---------------------------------------------------------------------------
// protocol v3 persistent session (Plan B Task 2, frozen)
// ---------------------------------------------------------------------------

/// 单个 stdin frame（一行 NDJSON）上限。
pub const HARD_MAX_SESSION_STDIN_FRAME_BYTES: usize = 64 * 1024;
/// 单个 stdout frame（一行 NDJSON，含结尾换行）上限。
pub const HARD_MAX_SESSION_STDOUT_FRAME_BYTES: usize = 256 * 1024;
/// 公开索引 living 角色硬上限；命中后 index 变 partial。
pub const HARD_MAX_SESSION_CHARACTERS: u64 = 100_000;
/// 公开索引头衔硬上限。
pub const HARD_MAX_SESSION_TITLES: u64 = 50_000;
/// 每角色关系引用硬上限。
pub const HARD_MAX_SESSION_RELATIONS_PER_CHARACTER: u64 = 128;
/// idle 自退时长硬上限（App 只能调低）。
pub const SESSION_HARD_MAX_IDLE_MS: u64 = 600_000;
/// search 请求 candidateCharacterIds 上限（App 端 soft cap == 硬上限）。
pub const MAX_SEARCH_CANDIDATE_IDS: usize = 16;
/// search 请求 primaryTitleKeys 上限。
pub const MAX_SEARCH_TITLE_KEYS: usize = 16;
/// literalNameQuery 最大字符数。
pub const MAX_SEARCH_LITERAL_QUERY_CHARS: usize = 80;
/// 单次 search 返回候选上限。
pub const MAX_SEARCH_RESULTS: u64 = 8;
/// 最小 idle 自退间隔（防御性下限，避免 0 值立即自杀）。
pub const SESSION_MIN_IDLE_MS: u64 = 1000;
