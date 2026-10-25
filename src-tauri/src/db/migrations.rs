//! 增量迁移。
//!
//! 迁移顺序编号：本卡为 `M1-01`、`M1-02`、`M1-03`。
//!
//! 执行约定：`Db::open` 在 `execute_batch(SCHEMA)` 与既有 `ensure_*` 调用之后调用
//! `migrations::run(&conn)?`。
//!
//! 追加位置：新迁移函数加在 `run()` 末尾、编号递增（`M1-04`…），不要改已有步骤的
//! 顺序与编号。
//!
//! 幂等要求：每一步必须能重复执行（`IF NOT EXISTS` / 查 `pragma_table_info` 之类），
//! 第二次执行为 no-op。

use rusqlite::Connection;

pub fn run(conn: &Connection) -> rusqlite::Result<()> {
    m1_01_messages_turn_id(conn)?;
    m1_02_turns_third_state(conn)?;
    m1_03_message_kind_guard(conn)?;
    Ok(())
}

/// M1-01：给 `messages` 补 `turn_id`，并加会话内的轮次索引。
///
/// 这里不能加 NOT NULL / CHECK：SQLite 不支持对已有数据的表直接
/// `ALTER TABLE ... ADD COLUMN ... NOT NULL`（无默认值会失败），也不支持
/// `ALTER TABLE ... ADD CHECK`（只能重建整表，见 docs/message-model.md §10.3）。
/// 因此老数据保持 NULL，非空保证由唯一写入函数 `Db::append_messages` 承担。
///
/// 索引沿用实体库已有的 `idx_messages_turn`；不要再建第二个等价索引，
/// 两个索引等于两份真相。
fn m1_01_messages_turn_id(conn: &Connection) -> rusqlite::Result<()> {
    super::ensure_column(conn, "messages", "turn_id", "TEXT")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_messages_turn
           ON messages(session_id, turn_id);",
    )?;
    Ok(())
}

/// M1-02：取消不再占用一个 status；`stop_reason` 为空的老行补成 `cancelled`。
fn m1_02_turns_third_state(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "UPDATE turns
            SET status = 'finished',
                stop_reason = coalesce(stop_reason, 'cancelled')
          WHERE status = 'cancelled';",
    )?;
    Ok(())
}

/// M1-03：`messages.kind` 只允许旧词表。SQLite 不能给已有表补 CHECK，
/// 所以用启动时重建的触发器兜住；词表只来自 `LEGACY_MESSAGE_KINDS`。
fn m1_03_message_kind_guard(conn: &Connection) -> rusqlite::Result<()> {
    let allowed = super::LEGACY_MESSAGE_KINDS
        .iter()
        .map(|kind| format!("'{}'", kind.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
    conn.execute_batch(&format!(
        "DROP TRIGGER IF EXISTS messages_kind_guard_ins;
         DROP TRIGGER IF EXISTS messages_kind_guard_upd;
         CREATE TRIGGER messages_kind_guard_ins
           BEFORE INSERT ON messages
           WHEN NEW.kind NOT IN ({allowed})
         BEGIN
           SELECT RAISE(ABORT, 'unknown message kind');
         END;
         CREATE TRIGGER messages_kind_guard_upd
           BEFORE UPDATE OF kind ON messages
           WHEN NEW.kind NOT IN ({allowed})
         BEGIN
           SELECT RAISE(ABORT, 'unknown message kind');
         END;"
    ))
}
