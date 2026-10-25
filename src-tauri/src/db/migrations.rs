//! 增量迁移。
//!
//! 迁移顺序编号：M1-01…M1-03，M2-01…M2-06。
//!
//! 执行约定：`Db::open` 在 `execute_batch(SCHEMA)` 与既有 `ensure_*` 调用之后调用
//! `migrations::run(&mut conn)?`。
//!
//! 追加位置：新迁移函数加在 `run()` 末尾、编号递增（`M2-06`…），不要改已有步骤的
//! 顺序与编号。
//!
//! 幂等要求：每一步必须能重复执行（`IF NOT EXISTS` / 查 `sqlite_master.type` /
//! `pragma_table_info` 之类），第二次执行为 no-op。整个迁移包在一个事务里：
//! SQLite 的 DDL 可回滚，任一步失败都不会留下半迁移的库。

use rusqlite::Connection;

pub fn run(conn: &mut Connection) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    m1_01_messages_turn_id(&tx)?;
    m1_02_turns_third_state(&tx)?;
    m1_03_message_kind_guard(&tx)?;
    m2_01_atoms_table(&tx)?;
    m2_02_drop_legacy_tables(&tx)?;
    m2_03_create_views(&tx)?;
    m2_04_atoms_kind_guard(&tx)?;
    m2_05_schema_sync(&tx)?;
    m2_06_atoms_schema(&tx)?;
    tx.commit()
}

/// M1-01：给旧 `messages` 表补 `turn_id`，并加会话内的轮次索引。
///
/// 新库里 `messages` 已经是视图，不能在视图上建索引；只有对象仍是旧表时才执行。
fn m1_01_messages_turn_id(conn: &Connection) -> rusqlite::Result<()> {
    if super::object_type(conn, "messages")?.as_deref() != Some("table") {
        return Ok(());
    }
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

/// M1-03：旧 `messages.kind` 只允许旧词表。新库里 `messages` 是视图，触发器不能建在
/// 视图上；M2-04 会把同一守卫建到 atoms 上。
fn m1_03_message_kind_guard(conn: &Connection) -> rusqlite::Result<()> {
    if super::object_type(conn, "messages")?.as_deref() != Some("table") {
        return Ok(());
    }
    let allowed = allowed_kinds_sql();
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

/// M2-01：建唯一写入表 `atoms` 与三个索引。
fn m2_01_atoms_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS atoms (
           id           TEXT PRIMARY KEY,
           session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
           channel      TEXT NOT NULL CHECK (channel IN ('chat', 'trace')),
           turn_id      TEXT,
           seq          INTEGER NOT NULL,
           at           INTEGER NOT NULL,
           role         TEXT CHECK (role IN ('user', 'player', 'agent', 'system')),
           author_id    TEXT,
           kind         TEXT NOT NULL,
           payload_json TEXT NOT NULL,
           refs_json    TEXT,
           ext_json     TEXT,
           source       TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live', 'replay')),
           truncated    INTEGER NOT NULL DEFAULT 0,
           sealed_at    INTEGER,
           UNIQUE (session_id, channel, seq)
         );
         CREATE INDEX IF NOT EXISTS idx_atoms_turn
           ON atoms(session_id, turn_id);
         CREATE INDEX IF NOT EXISTS idx_atoms_kind
           ON atoms(session_id, kind);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_atoms_open
           ON atoms(session_id, turn_id, kind) WHERE sealed_at IS NULL;",
    )?;
    Ok(())
}

/// M2-02：旧行在新结构里没有位置（§12.3），开发期直接丢弃。
///
/// 只在对象确实是 TABLE 时 DROP；迁移过的库里同名对象已经是 VIEW，直接跳过。
fn m2_02_drop_legacy_tables(conn: &Connection) -> rusqlite::Result<()> {
    for table in ["messages", "session_events"] {
        if super::object_type(conn, table)?.as_deref() == Some("table") {
            conn.execute_batch(&format!("DROP TABLE {table};"))?;
        }
    }
    Ok(())
}

/// M2-03：旧名字改成同名视图，读路径零改动。
fn m2_03_create_views(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE VIEW IF NOT EXISTS messages AS
           SELECT id, session_id, turn_id, seq, role, kind,
                  payload_json, at AS created_at, author_id
             FROM atoms WHERE channel = 'chat';
         CREATE VIEW IF NOT EXISTS session_events AS
           SELECT id, session_id, turn_id, seq, at, author_id,
                  kind, payload_json, source, truncated
             FROM atoms WHERE channel = 'trace';",
    )?;
    Ok(())
}

/// M2-04：kind 守卫搬到 atoms；只有 chat 通道校验旧消息词表。
///
/// 旧表上的 `messages_kind_guard_*` 随 M2-02 的 DROP TABLE 一起消失；这里仍显式
/// DROP 一次，保证从任何中间状态重跑都幂等。
fn m2_04_atoms_kind_guard(conn: &Connection) -> rusqlite::Result<()> {
    let allowed = allowed_kinds_sql();
    conn.execute_batch(&format!(
        "DROP TRIGGER IF EXISTS messages_kind_guard_ins;
         DROP TRIGGER IF EXISTS messages_kind_guard_upd;
         DROP TRIGGER IF EXISTS atoms_kind_guard_ins;
         DROP TRIGGER IF EXISTS atoms_kind_guard_upd;
         CREATE TRIGGER atoms_kind_guard_ins
           BEFORE INSERT ON atoms
           WHEN NEW.channel = 'chat' AND NEW.kind NOT IN ({allowed})
         BEGIN
           SELECT RAISE(ABORT, 'unknown message kind');
         END;
         CREATE TRIGGER atoms_kind_guard_upd
           BEFORE UPDATE OF kind ON atoms
           WHEN NEW.channel = 'chat' AND NEW.kind NOT IN ({allowed})
         BEGIN
           SELECT RAISE(ABORT, 'unknown message kind');
         END;"
    ))
}

/// M2-05：新库的一致性由 `schema.sql` 自身保证（直接建 atoms + 两个视图），
/// 没有额外 SQL。保留编号是为了迁移顺序在文档与代码里一一对应。
fn m2_05_schema_sync(_conn: &Connection) -> rusqlite::Result<()> {
    Ok(())
}

/// M2-06：补 payload 版本列。旧行由 SQLite 的列默认值填成 1；写成 NOT NULL
/// 是刻意的 —— 没有版本号的 atom 读方无法判断该怎么解释 payload。
fn m2_06_atoms_schema(conn: &Connection) -> rusqlite::Result<()> {
    super::ensure_column(conn, "atoms", "schema", "INTEGER NOT NULL DEFAULT 1")
}

fn allowed_kinds_sql() -> String {
    super::LEGACY_MESSAGE_KINDS
        .iter()
        .map(|kind| format!("'{}'", kind.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ")
}
