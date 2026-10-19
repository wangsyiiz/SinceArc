//! 本地持久化（SQLite）。
//!
//! v1 只建表、不接线；schema 里 `workspace_id` 一开始就在，
//! 因为 workspace 不是 UI 概念，而是 `fs/*` 回调的沙箱根。

pub const SCHEMA: &str = include_str!("schema.sql");
