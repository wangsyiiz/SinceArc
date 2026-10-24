//! 本地持久化（SQLite）。
//!
//! 一个会话 = 一行：**UI 会话 id 是主键**，ACP 的 sessionId 只是它的一个字段。
//! 早期版本反过来（ACP id 当主键 + 前端一张映射表桥接两套 id），那样每次重启
//! 都要重建映射，而且映射一旦没建立，流式内容就会写到别处去。
//!
//! `profiles` 存连接配置（SSH 密码不入库）、`sessions` 存会话列表、
//! `messages` 存消息。`workspaces` / `permission_rules` 是 E4 预留，尚未接线。

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::acp::AgentCaps;
use serde::{Deserialize, Serialize};

use crate::commands::{is_valid_theme, AppSettingsDto, ProfileDto, CONTEXT_MESSAGES_MAX};

pub const SCHEMA: &str = include_str!("schema.sql");

const SETTINGS_KEY_CONTEXT_MESSAGES: &str = "contextMessages";
const SETTINGS_KEY_THEME: &str = "theme";

/// 结构版本：与 schema.sql 不符时整表重建（自用工具，会话数据可再生）
const SCHEMA_VERSION: i64 = 6;

pub struct Db {
    conn: Mutex<Connection>,
}

/// 写这一层能明确指认的错误。
#[derive(Debug)]
pub enum DbError {
    Sql(rusqlite::Error),
    ProfileNotFound(String),
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sql(e) => write!(f, "{e}"),
            Self::ProfileNotFound(id) => write!(f, "profile 不存在：{id}"),
        }
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SessionRow {
    pub id: String,
    #[ts(optional = nullable)]
    pub acp_session_id: Option<String>,
    #[ts(optional = nullable)]
    pub mode_override: Option<String>,
    /// 还没绑定连接配置的草稿会话为 None
    #[ts(optional = nullable)]
    pub profile_id: Option<String>,
    pub title: String,
    pub cwd: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    /// 今天 / 昨天 / 更早 —— 由后端按机器本地时区判定，前端只做展示
    pub day_bucket: String,
    /// 供侧栏直接显示的简短时间：今天→`14:32`，更早→`10-21`
    pub display_time: String,
}

/// 写会话时用的模型：**只含真实列**。
///
/// `SessionRow` 带着 `day_bucket` / `display_time` 两个派生字段（SQL 里算出来的），
/// 拿它当写入入参会让「派生值」混进写路径 —— 于是要给它们加 `serde(default)`、
/// 前端类型还要标可选，谁都能往里塞一个不会落库的字段。读写分开就不用打这些补丁。
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SessionUpsert {
    pub id: String,
    #[ts(optional = nullable)]
    pub acp_session_id: Option<String>,
    #[ts(optional = nullable)]
    pub mode_override: Option<String>,
    #[ts(optional = nullable)]
    pub profile_id: Option<String>,
    pub title: String,
    pub cwd: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct BindingRow {
    #[ts(type = "number")]
    pub id: i64,
    pub acp_session_id: String,
    pub cwd: String,
    #[ts(type = "number")]
    pub bound_at: i64,
    pub reason: String,
    #[ts(type = "number | null")]
    pub superseded_at: Option<i64>,
}

/// 恢复一个界面会话所需的句柄。只有 `superseded_at IS NULL` 的绑定才算数。
#[derive(Debug, Clone)]
pub struct ResumeHandle {
    pub acp_session_id: String,
    pub cwd: String,
    /// 老库里的绑定可能还没有这一项。
    pub agent_name: Option<String>,
    /// 恢复前本地事件水位；第一条恢复后事件的 seq 与它比较。
    pub last_event_seq: Option<i64>,
    pub bound_at: i64,
}

#[derive(Debug, Default, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct PruneReport {
    #[ts(type = "number")]
    pub events_deleted: i64,
    #[ts(type = "number")]
    pub turns_deleted: i64,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct TurnRow {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub author_id: Option<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
    pub status: String,
    /// agent 原始的 stopReason；老库/孤儿轮为 None
    pub stop_reason: Option<String>,
}

/// 一条待落库的轨迹事件（已由 `trace` 解析、截断）。
pub struct EventInput {
    pub turn_id: String,
    pub author_id: Option<String>,
    pub kind: String,
    pub payload_json: String,
    pub source: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRow {
    pub id: String,
    pub seq: i64,
    pub at: i64,
    pub turn_id: String,
    pub author_id: Option<String>,
    pub kind: String,
    pub payload_json: String,
    pub source: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct MessageRow {
    pub id: String,
    #[ts(type = "number")]
    pub seq: i64,
    pub role: String,
    pub author_id: Option<String>,
    pub kind: String,
    /// 原始消息对象（前端 `Message` 的形状），不做有损转换
    #[ts(type = "unknown")]
    pub payload: serde_json::Value,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// 一页历史消息。游标分页只相信这里的 `has_more`，前端不自己算剩余条数。
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct MessagePage {
    /// 按 seq 升序，界面可直接作为一段连续历史追加
    pub messages: Vec<MessageRow>,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
}

/// 一个可加入群聊的玩家（docs/group-chat.md §1）
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct AgentUserRow {
    pub id: String,
    pub profile_id: String,
    /// 投递地址：该成员在自己那条连接上的 ACP 会话
    pub acp_session_id: String,
    pub name: String,
    pub handle: String,
    pub color: String,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// 写入用：seq 由后端按 MAX+1 分配，前端不需要知道
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageInput {
    pub id: String,
    pub role: String,
    /// 仅 role = 'player' 时有值：这条回答出自哪个 agent user（docs/group-chat.md §4）
    #[serde(default)]
    pub author_id: Option<String>,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub payload: serde_json::Value,
}

fn default_kind() -> String {
    "text".to_string()
}

/// 秒。历史列（profiles/sessions/messages 的 created_at/updated_at）用它，改动代价大于收益。
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 毫秒。轨迹（session_events.at / turns.*）用它 —— 一轮里几十条事件的先后只有毫秒分得开。
///
/// 血的教训：曾经 events 用秒、cutoff 用毫秒，清理逻辑一上线就会把**全部**轨迹判成过期
/// （1792666081 < 1792575304137000 恒真），是单测先炸出来的。
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// CREATE TABLE IF NOT EXISTS 不会给旧表补列；每加一列都要在这里登记一次，
/// 否则老库打开后一查新列就报 no such column。
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) -> rusqlite::Result<()> {
    let exists: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        params![column],
        |r| r.get(0),
    )?;
    if exists == 0 {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

/// 事件写入与显式 touch 共用的一条 SQL：只升不降，因此丢失/乱序的 touch 不会让水位倒退。
fn touch_handle_seq_on(
    conn: &Connection,
    session_id: &str,
    acp_session_id: Option<&str>,
    seq: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE session_bindings
            SET last_event_seq = MAX(COALESCE(last_event_seq, 0), ?3)
          WHERE session_id = ?1 AND superseded_at IS NULL
            AND (?2 IS NULL OR acp_session_id = ?2)",
        params![session_id, acp_session_id, seq],
    )?;
    Ok(())
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;

        // 旧结构（sessions 缺 acp_session_id 列）直接重建，不做逐列迁移：
        // 会话数据可再生产，留着半旧表只会让后面每一步都要判断两套结构。
        let has_table: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
            [],
            |r| r.get::<_, i64>(0),
        )? > 0;
        let has_column: bool = if has_table {
            conn.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='acp_session_id'",
                [],
                |r| r.get::<_, i64>(0),
            )? > 0
        } else {
            true
        };
        if has_table && !has_column {
            tracing::warn!(
                target: "sincearc::ipc",
                "旧库结构，重建 sessions/messages 表（配置保留）"
            );
            conn.execute_batch(
                "DROP TABLE IF EXISTS messages;
                 DROP TABLE IF EXISTS sessions;",
            )?;
        }

        conn.execute_batch(SCHEMA)?;
        ensure_column(&conn, "profiles", "default_mode", "TEXT")?;
        // E13.2：握手能力快照。老库补列，不清会话、不动 SCHEMA_VERSION。
        ensure_column(&conn, "profiles", "caps_json", "TEXT")?;
        ensure_column(&conn, "profiles", "caps_at", "INTEGER")?;
        ensure_column(&conn, "sessions", "mode_override", "TEXT")?;
        ensure_column(
            &conn,
            "sessions",
            "acp_state",
            "TEXT CHECK (acp_state IN ('ok', 'invalid'))",
        )?;
        // 群聊里的消息要能指认「谁说的」：不加这列，多 agent 群所有回复长得一样（docs/group-chat.md §4）
        ensure_column(&conn, "messages", "author_id", "TEXT")?;
        // E13.3：轮次终态要能解释「为什么停」。老库这里补列，不能整表重建。
        ensure_column(&conn, "turns", "stop_reason", "TEXT")?;
        // E13.7：会话恢复句柄。老库补列；已有 live 绑定保留，字段为 NULL。
        ensure_column(&conn, "session_bindings", "agent_name", "TEXT")?;
        ensure_column(&conn, "session_bindings", "last_event_seq", "INTEGER")?;
        // 轨迹时间列早期写成秒，与毫秒级的保留策略混用会把一切判成过期。
        // 一次性换算（< 1e11 一定不是毫秒：那相当于 1973 年之前），幂等。
        conn.execute_batch(
            "UPDATE session_events SET at = at * 1000 WHERE at > 0 AND at < 100000000000;
             UPDATE turns SET started_at = started_at * 1000
               WHERE started_at > 0 AND started_at < 100000000000;
             UPDATE turns SET ended_at = ended_at * 1000
               WHERE ended_at IS NOT NULL AND ended_at > 0 AND ended_at < 100000000000;",
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /* ---------------- profiles ---------------- */

    pub fn load_profiles(&self) -> rusqlite::Result<Vec<ProfileDto>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, name, launch_kind, program, args_json, default_cwd,
                    distro, shell, ssh_host, ssh_port, ssh_user, ssh_auth, ssh_key_path,
                    default_mode, caps_json, caps_at
             FROM profiles ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            let id: String = r.get(0)?;
            let args_json: String = r.get(4)?;
            let caps_json: Option<String> = r.get(14)?;
            let caps = caps_json.and_then(|raw| match serde_json::from_str::<AgentCaps>(&raw) {
                Ok(caps) => Some(caps),
                Err(e) => {
                    // 脏的旧数据只影响这一条显示，不能让整个配置列表读不出来。
                    tracing::warn!(
                        target: "sincearc::db",
                        profile = %id,
                        error = %e,
                        "能力快照无法解析，按未握手处理"
                    );
                    None
                }
            });
            Ok(ProfileDto {
                id,
                name: r.get(1)?,
                launch: r.get(2)?,
                program: r.get(3)?,
                args: serde_json::from_str(&args_json).unwrap_or_default(),
                cwd: r.get(5)?,
                default_mode: r.get(13)?,
                caps,
                caps_at: r.get(15)?,
                distro: r.get(6)?,
                shell: r.get(7)?,
                ssh_host: r.get(8)?,
                ssh_port: r.get::<_, Option<i64>>(9)?.map(|p| p as u16),
                ssh_user: r.get(10)?,
                ssh_auth: r.get(11)?,
                ssh_key_path: r.get(12)?,
                // 密码从不落盘：读回来永远是 None
                ssh_password: None,
            })
        })?;
        rows.collect()
    }

    /// 把一次握手的能力快照写进 profile。
    ///
    /// 影响 0 行说明 profile 不在库里（例如设置页还没保存的新草稿），
    /// 这时必须报错让调用方知道「这份能力没记住」，不能静默成功。
    pub fn save_profile_caps(
        &self,
        profile_id: &str,
        caps_json: &str,
        at: i64,
    ) -> Result<(), DbError> {
        let conn = self.conn.lock().expect("db poisoned");
        let changed = conn.execute(
            "UPDATE profiles SET caps_json = ?2, caps_at = ?3 WHERE id = ?1",
            params![profile_id, caps_json, at],
        )?;
        if changed == 0 {
            return Err(DbError::ProfileNotFound(profile_id.to_string()));
        }
        Ok(())
    }

    /// 整表对齐：列表里的 upsert，不在列表里的删掉（会话随外键级联）。
    pub fn save_profiles(&self, list: &[ProfileDto]) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let ts = now();

        for p in list {
            let args = serde_json::to_string(&p.args).unwrap_or_else(|_| "[]".into());
            // 决定「这个 agent 会报什么能力」的字段一旦变了，旧快照立刻作废 ——
            // 否则把命令从 hermes 改成 codex，面板还在用 hermes 的握手结论描述 codex。
            // 判据与「改了会话字段就退回未测试」同源：只认环境与命令，不认名字/颜色这类身份字段。
            let stale: bool = tx
                .query_row(
                    "SELECT program, args_json, launch_kind, distro, shell, default_cwd
                       FROM profiles WHERE id = ?1",
                    params![p.id],
                    |r| {
                        Ok(r.get::<_, String>(0)? != p.program
                            || r.get::<_, String>(1)? != args
                            || r.get::<_, String>(2)? != p.launch
                            || r.get::<_, Option<String>>(3)? != p.distro
                            || r.get::<_, Option<String>>(4)? != p.shell
                            || r.get::<_, String>(5)? != p.cwd)
                    },
                )
                .optional()?
                .unwrap_or(false);
            tx.execute(
                "INSERT INTO profiles
                   (id, name, launch_kind, distro, shell, program, args_json, env_json,
                    default_cwd, default_mode, ssh_host, ssh_port, ssh_user, ssh_auth, ssh_key_path,
                    created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'{}',?8,?9,?10,?11,?12,?13,?14,?15,?15)
                 ON CONFLICT(id) DO UPDATE SET
                   name=excluded.name, launch_kind=excluded.launch_kind,
                   distro=excluded.distro, shell=excluded.shell,
                   program=excluded.program, args_json=excluded.args_json,
                   default_cwd=excluded.default_cwd, default_mode=excluded.default_mode,
                   ssh_host=excluded.ssh_host,
                   ssh_port=excluded.ssh_port, ssh_user=excluded.ssh_user,
                   ssh_auth=excluded.ssh_auth, ssh_key_path=excluded.ssh_key_path,
                   caps_json=CASE WHEN ?16 THEN NULL ELSE profiles.caps_json END,
                   caps_at=CASE WHEN ?16 THEN NULL ELSE profiles.caps_at END,
                   updated_at=excluded.updated_at",
                params![
                    p.id,
                    p.name,
                    p.launch,
                    p.distro,
                    p.shell,
                    p.program,
                    args,
                    p.cwd,
                    p.default_mode,
                    p.ssh_host,
                    p.ssh_port.map(|v| v as i64),
                    p.ssh_user,
                    p.ssh_auth,
                    p.ssh_key_path,
                    ts,
                    stale
                ],
            )?;
        }

        let keep: Vec<String> = list.iter().map(|p| p.id.clone()).collect();
        let existing: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM profiles")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let doomed: Vec<String> = existing
            .into_iter()
            .filter(|id| !keep.contains(id))
            .collect();

        if !doomed.is_empty() {
            let marks = std::iter::repeat("?")
                .take(doomed.len())
                .collect::<Vec<_>>()
                .join(",");
            // workspaces 对 profiles 是 RESTRICT（防误删沙箱根），删除顺序显式写出来
            tx.execute(
                &format!("DELETE FROM workspaces WHERE profile_id IN ({marks})"),
                rusqlite::params_from_iter(&doomed),
            )?;
            tx.execute(
                &format!("DELETE FROM profiles WHERE id IN ({marks})"),
                rusqlite::params_from_iter(&doomed),
            )?;
        }

        tx.commit()
    }

    /* ---------------- settings ---------------- */

    pub fn load_settings(&self) -> rusqlite::Result<AppSettingsDto> {
        Ok(self.load_settings_report()?.0)
    }

    /// 读设置，**同时把读不出来的脏值收集成给人看的说明**。
    ///
    /// 脏值不能让应用打不开（老库可能是别的版本写的），但也不许静默跳过：
    /// 每条都写日志（`sincearc::settings`），并把说明交给界面进诊断面板
    /// （所有者 2026-10-23：不阻塞、但必须留下记录）。
    pub fn load_settings_report(&self) -> rusqlite::Result<(AppSettingsDto, Vec<String>)> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let mut rows = stmt.query([])?;
        let mut settings = AppSettingsDto::default();
        let mut issues: Vec<String> = Vec::new();

        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            match key.as_str() {
                SETTINGS_KEY_CONTEXT_MESSAGES => match value.parse::<u32>() {
                    Ok(n) if n <= CONTEXT_MESSAGES_MAX => settings.context_messages = n,
                    _ => {
                        let note = format!(
                            "设置项 {key} 的值 `{value}` 不认识（应为 0–{CONTEXT_MESSAGES_MAX} 的整数），已用默认值 {}",
                            settings.context_messages
                        );
                        tracing::warn!(target: "sincearc::settings", key = %key, value = %value, "{note}");
                        issues.push(note);
                    }
                },
                SETTINGS_KEY_THEME if is_valid_theme(&value) => settings.theme = value,
                SETTINGS_KEY_THEME => {
                    let note =
                        format!("设置项 {key} 的值 `{value}` 不认识（应为 dark/light/system），已用默认值 {}", settings.theme);
                    tracing::warn!(target: "sincearc::settings", key = %key, value = %value, "{note}");
                    issues.push(note);
                }
                _ => {}
            }
        }

        Ok((settings, issues))
    }

    pub fn save_settings(&self, settings: &AppSettingsDto) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![
                SETTINGS_KEY_CONTEXT_MESSAGES,
                settings.context_messages.to_string()
            ],
        )?;
        tx.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SETTINGS_KEY_THEME, settings.theme.as_str()],
        )?;
        tx.commit()
    }

    /* ---------------- sessions ---------------- */

    pub fn list_sessions(&self, profile_id: Option<&str>) -> rusqlite::Result<Vec<SessionRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let sql = "SELECT id, acp_session_id, profile_id, title, cwd, created_at, updated_at,
                          mode_override,
                          CASE
                            WHEN date(updated_at,'unixepoch','localtime') = date('now','localtime') THEN 'today'
                            WHEN date(updated_at,'unixepoch','localtime') = date('now','localtime','-1 day') THEN 'yesterday'
                            ELSE 'earlier'
                          END AS day_bucket,
                          CASE
                            WHEN date(updated_at,'unixepoch','localtime') = date('now','localtime')
                              THEN strftime('%H:%M', updated_at,'unixepoch','localtime')
                            ELSE strftime('%m-%d', updated_at,'unixepoch','localtime')
                          END AS display_time
                   FROM sessions
                   WHERE (?1 IS NULL OR profile_id = ?1)
                   ORDER BY updated_at DESC, created_at DESC";
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![profile_id], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                acp_session_id: r.get(1)?,
                profile_id: r.get(2)?,
                title: r.get(3)?,
                cwd: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                mode_override: r.get(7)?,
                day_bucket: r.get(8)?,
                display_time: r.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn upsert_session(&self, row: &SessionUpsert) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT INTO sessions (id, acp_session_id, profile_id, title, cwd, created_at, updated_at,
                                   mode_override)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET
               -- 绑定过的 ACP id 不能被一次空值覆盖掉
               acp_session_id = COALESCE(excluded.acp_session_id, sessions.acp_session_id),
               profile_id = excluded.profile_id,
               title = excluded.title,
               cwd = excluded.cwd,
               -- mode_override 只由 set_mode_override 在用户手切成功后写；
               -- 普通会话保存不带该字段，跟着 excluded 更新会把覆盖值误清成 NULL。
               updated_at = excluded.updated_at",
            params![
                row.id,
                row.acp_session_id,
                row.profile_id,
                row.title,
                row.cwd,
                row.created_at,
                row.updated_at,
                row.mode_override
            ],
        )?;
        Ok(())
    }

    pub fn bind_acp_session(
        &self,
        id: &str,
        acp_session_id: &str,
        cwd: &str,
        reason: &str,
    ) -> rusqlite::Result<()> {
        self.bind_acp_session_with_agent(id, acp_session_id, cwd, reason, None)
    }

    /// 绑定 ACP 会话，同时记下这次握手的 agent 名（恢复时做等价性检查）。
    ///
    /// 同一个 live acp id 重复绑定时不清水位；只有换到新 id 才新开一行。
    pub fn bind_acp_session_with_agent(
        &self,
        id: &str,
        acp_session_id: &str,
        cwd: &str,
        reason: &str,
        agent_name: Option<&str>,
    ) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let bound_at = now_ms();
        let live: Option<String> = tx
            .query_row(
                "SELECT acp_session_id FROM session_bindings
                 WHERE session_id = ?1 AND superseded_at IS NULL
                 ORDER BY bound_at DESC, id DESC LIMIT 1",
                params![id],
                |r| r.get(0),
            )
            .optional()?;

        if live.as_deref() != Some(acp_session_id) {
            tx.execute(
                "UPDATE session_bindings SET superseded_at = ?2
                 WHERE session_id = ?1 AND superseded_at IS NULL",
                params![id, bound_at],
            )?;
            tx.execute(
                "INSERT INTO session_bindings
                   (session_id, acp_session_id, cwd, agent_name, bound_at, reason)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, acp_session_id, cwd, agent_name, bound_at, reason],
            )?;
        } else {
            // 前端连接成功后还会幂等绑定一次（不带 agent 名）。
            // 这次更新不能让已经记下的 agent 名/水位归空。
            tx.execute(
                "UPDATE session_bindings
                    SET cwd = CASE WHEN ?2 <> '' THEN ?2 ELSE cwd END,
                        agent_name = COALESCE(?3, agent_name)
                  WHERE session_id = ?1 AND acp_session_id = ?4
                    AND superseded_at IS NULL",
                params![id, cwd, agent_name, acp_session_id],
            )?;
        }

        tx.execute(
            "UPDATE sessions SET acp_session_id = ?2, acp_state = 'ok', updated_at = ?3
             WHERE id = ?1",
            params![id, acp_session_id, now()],
        )?;
        tx.commit()
    }

    pub fn live_handle(&self, session_id: &str) -> rusqlite::Result<Option<ResumeHandle>> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.query_row(
            "SELECT acp_session_id, cwd, agent_name, last_event_seq, bound_at
               FROM session_bindings
              WHERE session_id = ?1 AND superseded_at IS NULL
              ORDER BY bound_at DESC, id DESC LIMIT 1",
            params![session_id],
            |r| {
                Ok(ResumeHandle {
                    acp_session_id: r.get(0)?,
                    cwd: r.get(1)?,
                    agent_name: r.get(2)?,
                    last_event_seq: r.get(3)?,
                    bound_at: r.get(4)?,
                })
            },
        )
        .optional()
    }

    /// 记本地事件水位。只更新匹配 acp id 的 live 绑定，旧绑定/别的成员不会串。
    pub fn touch_handle_seq(
        &self,
        session_id: &str,
        acp_session_id: &str,
        seq: i64,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        touch_handle_seq_on(&conn, session_id, Some(acp_session_id), seq)
    }

    pub fn mark_acp_invalid(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "UPDATE sessions SET acp_state = 'invalid', updated_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    pub fn bindings(&self, session_id: &str) -> rusqlite::Result<Vec<BindingRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, acp_session_id, cwd, bound_at, reason, superseded_at
             FROM session_bindings
             WHERE session_id = ?1
             ORDER BY bound_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(BindingRow {
                id: r.get(0)?,
                acp_session_id: r.get(1)?,
                cwd: r.get(2)?,
                bound_at: r.get(3)?,
                reason: r.get(4)?,
                superseded_at: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn mode_override(&self, ui_session_id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.query_row(
            "SELECT mode_override FROM sessions WHERE id = ?1",
            params![ui_session_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|v| v.flatten())
    }

    pub fn set_mode_override(
        &self,
        ui_session_id: &str,
        value: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "UPDATE sessions SET mode_override = ?2, updated_at = ?3 WHERE id = ?1",
            params![ui_session_id, value, now()],
        )?;
        Ok(())
    }

    /// 仅当会话标题仍是「未命名」时才写入。
    ///
    /// 这里只执行 SQL：哪些值算「未命名」、标题从哪来，都是业务判断，
    /// 由调用方（commands 层）决定 —— 见 docs/architecture.md §6.1。
    pub fn set_title_if_unnamed(
        &self,
        session_id: &str,
        title: &str,
        placeholders: &[&str],
    ) -> rusqlite::Result<usize> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let mut sql = String::from(
            "UPDATE sessions SET title = ?1 WHERE id = ?2 AND (title IS NULL OR title = ''",
        );
        let mut binds: Vec<String> = vec![title.to_string(), session_id.to_string()];
        for ph in placeholders.iter().filter(|p| !p.is_empty()) {
            sql.push_str(&format!(" OR title = ?{}", binds.len() + 1));
            binds.push((*ph).to_string());
        }
        sql.push(')');
        let n = tx.execute(&sql, rusqlite::params_from_iter(binds.iter()))?;
        tx.commit()?;
        Ok(n)
    }

    pub fn delete_session(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 该 profile 最近绑定的 ACP 会话（重连时优先 load 它）
    pub fn last_acp_session(&self, profile_id: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.query_row(
            "SELECT acp_session_id FROM sessions
             WHERE profile_id = ?1 AND acp_session_id IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1",
            params![profile_id],
            |r| r.get(0),
        )
        .optional()
        .map(|v: Option<Option<String>>| v.flatten())
    }

    /* ---------------- messages ---------------- */

    pub fn append_messages(&self, session_id: &str, msgs: &[MessageInput]) -> rusqlite::Result<()> {
        if msgs.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let base: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM messages WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let ts = now();
        for (i, m) in msgs.iter().enumerate() {
            tx.execute(
                "INSERT INTO messages
                   (id, session_id, seq, role, kind, payload_json, created_at, author_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   role = excluded.role,
                   kind = excluded.kind,
                   author_id = excluded.author_id",
                params![
                    m.id,
                    session_id,
                    base + i as i64 + 1,
                    m.role,
                    m.kind,
                    m.payload.to_string(),
                    ts,
                    m.author_id
                ],
            )?;
        }
        tx.execute(
            "UPDATE sessions SET updated_at = ?1 WHERE id = ?2",
            params![ts, session_id],
        )?;
        tx.commit()
    }

    /* ---------------- 轨迹保留策略 ---------------- */

    /// 清理超出保留期的轨迹。所有者拍板：**超出直接删除**，不归档。
    ///
    /// 两个维度同时生效：
    /// - 时间：`at` 早于 `cutoff_ms` 的事件，以及结束于其前的轮次；
    /// - 体量：单会话只保留最近 `max_events_per_session` 条事件。
    ///
    /// 返回删了多少，便于日志与「清理是否真的发生」的核对 —— 界面上写着会自动清理，
    /// 那就必须真的清理，否则就是一句谎话。
    pub fn prune_traces(
        &self,
        cutoff_ms: i64,
        max_events_per_session: i64,
        allow_wipe: bool,
    ) -> rusqlite::Result<PruneReport> {
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let mut report = PruneReport::default();

        // 防呆：时间过滤若会删掉**全部**事件，先当成单位/时钟错误挡下来。
        // 真出过事：events.at 用秒、cutoff 用毫秒，一上线就把所有轨迹判成过期。
        let total: i64 = tx.query_row("SELECT COUNT(*) FROM session_events", [], |r| r.get(0))?;
        let expired: i64 = tx.query_row(
            "SELECT COUNT(*) FROM session_events WHERE at < ?1",
            params![cutoff_ms],
            |r| r.get(0),
        )?;
        let wipe_all = total > 0 && expired == total;
        if wipe_all && !allow_wipe {
            tracing::warn!(
                target: "sincearc::trace",
                total, cutoff_ms,
                "时间过滤会清空全部轨迹，疑似时间单位不一致，已跳过（要真删请显式 allow_wipe）"
            );
        } else {
            report.events_deleted += tx.execute(
                "DELETE FROM session_events WHERE at < ?1",
                params![cutoff_ms],
            )? as i64;
        }
        // 轮次的时间过滤与事件**同时**受防呆保护：只挡事件、放行轮次的话，
        // 单位错了仍然会把轮次清空（测试里就撞到过这个只挡一半的版本）。
        if !(wipe_all && !allow_wipe) {
            report.turns_deleted += tx.execute(
                "DELETE FROM turns WHERE COALESCE(ended_at, started_at) < ?1",
                params![cutoff_ms],
            )? as i64;
        }

        // 单会话体量上限：先找出该保留的最小 seq，再删更早的
        let mut sessions: Vec<String> = {
            let mut stmt = tx.prepare("SELECT DISTINCT session_id FROM session_events")?;
            let list = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            list
        };
        for sid in sessions.drain(..) {
            let cutoff_seq: Option<i64> = tx
                .query_row(
                    "SELECT seq FROM session_events WHERE session_id = ?1
                      ORDER BY seq DESC LIMIT 1 OFFSET ?2",
                    params![sid, (max_events_per_session - 1).max(0)],
                    |r| r.get(0),
                )
                .ok();
            if let Some(seq) = cutoff_seq {
                report.events_deleted += tx.execute(
                    "DELETE FROM session_events WHERE session_id = ?1 AND seq < ?2",
                    params![sid, seq],
                )? as i64;
            }
        }

        // 事件被清空的轮次没有展示价值，但**还没收尾**的轮次不能动：
        // running 与 waiting_approval 都算活动轮。
        report.turns_deleted += tx.execute(
            "DELETE FROM turns
              WHERE status NOT IN ('running', 'waiting_approval')
                AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.turn_id = turns.id)",
            [],
        )? as i64;

        tx.commit()?;
        Ok(report)
    }

    /* ---------------- turns（轨迹的轮次） ---------------- */

    /// 记一轮的开始。`turn_id` 由命令层生成并同时交给 `AppState.turns`，
    /// 保证事件、轮次、前端看到的「正在跑」是同一个 id。
    pub fn start_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        prompt: &str,
        author_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT OR REPLACE INTO turns
               (id, session_id, prompt, author_id, started_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running')",
            params![turn_id, session_id, prompt, author_id, now_ms()],
        )?;
        Ok(())
    }

    /// 收一轮。`status` 允许 finished / failed / cancelled —— 「是否还在跑」不该由调用方随口决定。
    /// `stop_reason` 是 agent 返回的原文，不能只留映射后的状态。
    pub fn end_turn(
        &self,
        turn_id: &str,
        status: &str,
        stop_reason: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "UPDATE turns SET ended_at = ?1, status = ?2, stop_reason = ?3 WHERE id = ?4",
            params![now_ms(), status, stop_reason, turn_id],
        )?;
        Ok(())
    }

    /// 权限请求到达：只有仍在 running 的轮才进入 waiting_approval。
    /// 返回受影响行数，0 表示这一轮已经结束或不在等待态。
    pub fn mark_turn_waiting_approval(&self, turn_id: &str) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "UPDATE turns SET status = 'waiting_approval'
              WHERE id = ?1 AND status = 'running'",
            params![turn_id],
        )
    }

    /// 权限答完：只把仍停在 waiting_approval 的轮恢复成 running。
    /// 若 agent 已经先一步回了终态，这里不能把 finished / cancelled 盖回去。
    pub fn resume_turn_after_approval(&self, turn_id: &str) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "UPDATE turns SET status = 'running'
              WHERE id = ?1 AND status = 'waiting_approval'",
            params![turn_id],
        )
    }

    /// 最近几轮（含正文与耗时），倒序。
    pub fn load_turns(&self, session_id: &str, limit: i64) -> rusqlite::Result<Vec<TurnRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, session_id, prompt, author_id, started_at, ended_at, status, stop_reason
               FROM turns WHERE session_id = ?1
              -- 同一毫秒内连续开两轮时，只按 started_at 排会不稳定；rowid 兜底保证确定性
              ORDER BY started_at DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![session_id, limit], |r| {
                Ok(TurnRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    prompt: r.get(2)?,
                    author_id: r.get(3)?,
                    started_at: r.get(4)?,
                    ended_at: r.get(5)?,
                    status: r.get(6)?,
                    stop_reason: r.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /* ---------------- session_events（轨迹源数据） ---------------- */

    /// 追加轨迹事件。seq 由库按会话自增，保证顺序与重启后一致。
    ///
    /// 只做存储：哪些事件算轨迹、怎么截断，由 `trace` 模块决定（见 architecture §6.1）。
    pub fn append_events(
        &self,
        session_id: &str,
        events: &[EventInput],
    ) -> rusqlite::Result<usize> {
        if events.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().expect("db poisoned");
        let tx = conn.transaction()?;
        let mut seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM session_events WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )?;
        let at = now_ms();
        for e in events {
            seq += 1;
            tx.execute(
                "INSERT INTO session_events
                   (id, session_id, turn_id, seq, at, author_id, kind, payload_json, source, truncated)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    format!("{session_id}-{seq}"),
                    session_id,
                    e.turn_id,
                    seq,
                    at,
                    e.author_id,
                    e.kind,
                    e.payload_json,
                    e.source,
                    e.truncated as i64,
                ],
            )?;
        }
        // 水位更新与事件写入共用同一个事务：不为每条事件多开一次写事务。
        // 一次 append 里无论多少条，只更新最终 seq。
        touch_handle_seq_on(&tx, session_id, None, seq)?;
        tx.commit()?;
        Ok(events.len())
    }

    pub fn load_events(&self, session_id: &str, limit: i64) -> rusqlite::Result<Vec<EventRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, seq, at, turn_id, author_id, kind, payload_json, source, truncated
               FROM session_events WHERE session_id = ?1
              ORDER BY seq DESC LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![session_id, limit], |r| {
                Ok(EventRow {
                    id: r.get(0)?,
                    seq: r.get(1)?,
                    at: r.get(2)?,
                    turn_id: r.get(3)?,
                    author_id: r.get(4)?,
                    kind: r.get(5)?,
                    payload_json: r.get(6)?,
                    source: r.get(7)?,
                    truncated: r.get::<_, i64>(8)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 该会话最后一条 usage 事件。`session_events.session_id` 存的是 UI 会话 id。
    ///
    /// 这条查询只服务于「重启/切回会话时先显示最后一次真实占用」；轨迹面板不消费 usage。
    pub fn latest_usage(
        &self,
        session_id: &str,
    ) -> rusqlite::Result<Option<(serde_json::Value, Option<String>)>> {
        let conn = self.conn.lock().expect("db poisoned");
        let row = conn
            .query_row(
                "SELECT payload_json, author_id
                   FROM session_events
                  WHERE session_id = ?1 AND kind = 'usage'
                  ORDER BY at DESC, rowid DESC LIMIT 1",
                params![session_id],
                |r| {
                    let payload: String = r.get(0)?;
                    let value =
                        serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null);
                    Ok((value, r.get(1)?))
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn load_messages(&self, session_id: &str, limit: i64) -> rusqlite::Result<Vec<MessageRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, seq, role, kind, payload_json, created_at, author_id
             FROM messages WHERE session_id = ?1 ORDER BY seq DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![session_id, limit], |r| {
            let payload: String = r.get(4)?;
            Ok(MessageRow {
                id: r.get(0)?,
                seq: r.get(1)?,
                role: r.get(2)?,
                kind: r.get(3)?,
                payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
                created_at: r.get(5)?,
                author_id: r.get(6)?,
            })
        })?;
        let mut out: Vec<MessageRow> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.reverse();
        Ok(out)
    }

    /// 游标分页：`before_seq` 为 None 取最新一页，否则取严格早于该 seq 的一页。
    ///
    /// 多取一条只用于判定 `has_more`，不返回给界面；返回顺序与 `load_messages` 一致（升序）。
    pub fn load_messages_page(
        &self,
        session_id: &str,
        limit: i64,
        before_seq: Option<i64>,
    ) -> rusqlite::Result<MessagePage> {
        let limit = limit.max(0);
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, seq, role, kind, payload_json, created_at, author_id
             FROM messages
             WHERE session_id = ?1 AND (?2 IS NULL OR seq < ?2)
             ORDER BY seq DESC LIMIT ?3",
        )?;
        let mut messages = stmt
            .query_map(
                params![session_id, before_seq, limit.saturating_add(1)],
                |r| {
                    let payload: String = r.get(4)?;
                    Ok(MessageRow {
                        id: r.get(0)?,
                        seq: r.get(1)?,
                        role: r.get(2)?,
                        kind: r.get(3)?,
                        payload: serde_json::from_str(&payload)
                            .unwrap_or(serde_json::Value::Null),
                        created_at: r.get(5)?,
                        author_id: r.get(6)?,
                    })
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let has_more = messages.len() > limit as usize;
        if has_more {
            // DESC 的最后一条是这一页之外最老的那条，丢掉。
            messages.pop();
        }
        messages.reverse();
        Ok(MessagePage {
            messages,
            has_more,
        })
    }

    /// 读一条元数据（发现结果缓存之类）。键值表的用途见 schema.sql 的 app_meta。
    pub fn meta_get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT value FROM app_meta WHERE key = ?1")?;
        let mut rows = stmt.query([key])?;
        rows.next()?.map(|r| r.get::<_, String>(0)).transpose()
    }

    /* ---------- 群聊成员（docs/group-chat.md） ---------- */

    /// 反查：某个 ACP 会话是哪个群成员的身份（一个会话至多一个身份，schema v4 的唯一约束）
    pub fn agent_user_by_acp_session(
        &self,
        acp_session_id: &str,
    ) -> rusqlite::Result<Option<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, acp_session_id, name, handle, color, created_at
             FROM agent_users WHERE acp_session_id = ?1",
        )?;
        let mut rows = stmt.query(params![acp_session_id])?;
        match rows.next()? {
            Some(r) => Ok(Some(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })),
            None => Ok(None),
        }
    }

    pub fn list_agent_users(&self) -> rusqlite::Result<Vec<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, acp_session_id, name, handle, color, created_at
             FROM agent_users ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// 新增或更新一个玩家。handle 与 (profile, acp_session) 都是唯一键 ——
    /// 冲突时把约束名带出来，让调用方能给出「这个 @ 已经被占了」这种准确的话。
    pub fn upsert_agent_user(&self, row: &AgentUserRow) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT INTO agent_users
               (id, profile_id, acp_session_id, name, handle, color, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET
               profile_id=excluded.profile_id, acp_session_id=excluded.acp_session_id,
               name=excluded.name, handle=excluded.handle, color=excluded.color",
            rusqlite::params![
                row.id,
                row.profile_id,
                row.acp_session_id,
                row.name,
                row.handle,
                row.color,
                row.created_at
            ],
        )?;
        Ok(())
    }

    pub fn delete_agent_user(&self, id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute("DELETE FROM agent_users WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn session_members(&self, session_id: &str) -> rusqlite::Result<Vec<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT u.id, u.profile_id, u.acp_session_id, u.name, u.handle, u.color, u.created_at
             FROM session_members m JOIN agent_users u ON u.id = m.user_id
             WHERE m.session_id = ?1 ORDER BY m.added_at ASC",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            Ok(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// 幂等：重复拉同一个人进群不是错误
    pub fn add_member(&self, session_id: &str, user_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "INSERT OR IGNORE INTO session_members (session_id, user_id, added_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![session_id, user_id, now()],
        )?;
        Ok(())
    }

    pub fn remove_member(&self, session_id: &str, user_id: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("db poisoned");
        conn.execute(
            "DELETE FROM session_members WHERE session_id = ?1 AND user_id = ?2",
            rusqlite::params![session_id, user_id],
        )?;
        Ok(())
    }

    /// 按 handle 找成员（`@` 投递用）；大小写不敏感
    pub fn find_by_handle(&self, handle: &str) -> rusqlite::Result<Option<AgentUserRow>> {
        let conn = self.conn.lock().expect("db poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, profile_id, acp_session_id, name, handle, color, created_at
             FROM agent_users WHERE handle = ?1 COLLATE NOCASE",
        )?;
        let mut rows = stmt.query([handle.trim_start_matches('@')])?;
        match rows.next()? {
            Some(r) => Ok(Some(AgentUserRow {
                id: r.get(0)?,
                profile_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                name: r.get(3)?,
                handle: r.get(4)?,
                color: r.get(5)?,
                created_at: r.get(6)?,
            })),
            None => Ok(None),
        }
    }

    /// 写一条元数据（覆盖）。
    pub fn meta_set(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO app_meta(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> (Db, std::path::PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-db-test-{}-{nanos}.db",
            std::process::id()
        ));
        (Db::open(&path).expect("open temp db"), path)
    }

    /// 加列之前的旧库：CREATE TABLE IF NOT EXISTS 不会补列，
    /// 所以 open() 必须靠 ensure_column 补齐，而且不能顺手把会话清掉。
    #[test]
    fn old_db_gains_mode_columns_without_losing_sessions() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-db-migrate-{}-{nanos}.db",
            std::process::id()
        ));

        {
            let conn = Connection::open(&path).expect("raw open");
            // 关键：保留 acp_session_id（否则会被判定为需要整表重建），但两列都还没有
            conn.execute_batch(
                "CREATE TABLE profiles (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL,
                   launch_kind TEXT NOT NULL CHECK (launch_kind IN ('local','wsl','ssh')),
                   distro TEXT, shell TEXT, program TEXT NOT NULL,
                   args_json TEXT NOT NULL DEFAULT '[]', env_json TEXT NOT NULL DEFAULT '{}',
                   default_cwd TEXT NOT NULL,
                   ssh_host TEXT, ssh_port INTEGER, ssh_user TEXT, ssh_auth TEXT, ssh_key_path TEXT,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE sessions (
                   id TEXT PRIMARY KEY, acp_session_id TEXT,
                   profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
                   title TEXT NOT NULL DEFAULT '新会话', cwd TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO sessions (id, acp_session_id, title, cwd, created_at, updated_at)
                   VALUES ('s-old', 'acp-old', '老会话', '/tmp', 1, 1);",
            )
            .expect("seed old schema");
        }

        let db = Db::open(&path).expect("迁移后应当能打开");

        let rows = db.list_sessions(None).expect("list");
        assert_eq!(rows.len(), 1, "旧会话不该被清掉");
        assert_eq!(rows[0].id, "s-old");
        assert_eq!(rows[0].mode_override, None);

        db.set_mode_override("s-old", Some("dont_ask"))
            .expect("写入覆盖值");
        assert_eq!(
            db.mode_override("s-old").expect("读回").as_deref(),
            Some("dont_ask")
        );

        db.set_mode_override("s-old", None).expect("改回跟随");
        assert_eq!(db.mode_override("s-old").expect("读回"), None);

        std::fs::remove_file(&path).ok();
    }

    /// E13.3 之前建的 turns 表没有 stop_reason；打开旧库后要能补列并正常读写。
    #[test]
    fn old_db_gains_turn_stop_reason_without_losing_turns() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-db-turn-migrate-{}-{nanos}.db",
            std::process::id()
        ));

        {
            let conn = Connection::open(&path).expect("raw open");
            conn.execute_batch(
                "CREATE TABLE profiles (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL,
                   launch_kind TEXT NOT NULL CHECK (launch_kind IN ('local','wsl','ssh')),
                   distro TEXT, shell TEXT, program TEXT NOT NULL,
                   args_json TEXT NOT NULL DEFAULT '[]', env_json TEXT NOT NULL DEFAULT '{}',
                   default_cwd TEXT NOT NULL,
                   ssh_host TEXT, ssh_port INTEGER, ssh_user TEXT, ssh_auth TEXT, ssh_key_path TEXT,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE sessions (
                   id TEXT PRIMARY KEY, acp_session_id TEXT,
                   profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
                   title TEXT NOT NULL DEFAULT '新会话', cwd TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE turns (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL,
                   prompt TEXT NOT NULL DEFAULT '',
                   author_id TEXT,
                   started_at INTEGER NOT NULL,
                   ended_at INTEGER,
                   status TEXT NOT NULL DEFAULT 'running');
                 INSERT INTO sessions (id, acp_session_id, title, cwd, created_at, updated_at)
                   VALUES ('s-old', 'acp-old', '老会话', '/tmp', 1, 1);
                 INSERT INTO turns (id, session_id, prompt, started_at, status)
                   VALUES ('t-old', 's-old', '老问题', 1, 'running');",
            )
            .expect("seed old schema");
        }

        let db = Db::open(&path).expect("迁移后应当能打开");
        let turns = db.load_turns("s-old", 10).expect("旧轮次不该丢");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].id, "t-old");
        assert_eq!(turns[0].stop_reason, None);

        db.end_turn("t-old", "finished", Some("end_turn"))
            .expect("新列可写");
        let turns = db.load_turns("s-old", 10).expect("新列可读");
        assert_eq!(turns[0].status, "finished");
        assert_eq!(turns[0].stop_reason.as_deref(), Some("end_turn"));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn settings_new_db_returns_defaults() {
        let (db, path) = temp_db();
        let settings = db.load_settings().expect("load settings");
        assert_eq!(settings.context_messages, 5);
        assert_eq!(settings.theme, "dark");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn settings_round_trip() {
        let (db, path) = temp_db();
        db.save_settings(&AppSettingsDto {
            context_messages: 17,
            theme: "system".into(),
        })
        .expect("save settings");

        let settings = db.load_settings().expect("load settings");
        assert_eq!(settings.context_messages, 17);
        assert_eq!(settings.theme, "system");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn settings_old_db_without_settings_table_keeps_profiles() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-db-settings-migrate-{}-{nanos}.db",
            std::process::id()
        ));

        {
            let conn = Connection::open(&path).expect("raw open");
            conn.execute_batch(
                "CREATE TABLE profiles (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL,
                   launch_kind TEXT NOT NULL CHECK (launch_kind IN ('local','wsl','ssh')),
                   distro TEXT, shell TEXT, program TEXT NOT NULL,
                   args_json TEXT NOT NULL DEFAULT '[]', env_json TEXT NOT NULL DEFAULT '{}',
                   default_cwd TEXT NOT NULL,
                   ssh_host TEXT, ssh_port INTEGER, ssh_user TEXT, ssh_auth TEXT, ssh_key_path TEXT,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 CREATE TABLE sessions (
                   id TEXT PRIMARY KEY, acp_session_id TEXT,
                   profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
                   title TEXT NOT NULL DEFAULT '新会话', cwd TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO profiles
                   (id, name, launch_kind, program, args_json, default_cwd, created_at, updated_at)
                   VALUES ('p-old', '旧连接', 'local', 'hermes', '[\"acp\"]', '/tmp', 1, 1);
                 INSERT INTO sessions
                   (id, acp_session_id, profile_id, title, cwd, created_at, updated_at)
                   VALUES ('s-old', 'acp-old', 'p-old', '老会话', '/tmp', 1, 1);",
            )
            .expect("seed old schema");
        }

        let db = Db::open(&path).expect("旧库应能打开并补上 settings 表");
        let profiles = db.load_profiles().expect("旧连接不该丢");
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].id, "p-old");

        let settings = db.load_settings().expect("settings 应可用");
        assert_eq!(settings.context_messages, 5);
        assert_eq!(settings.theme, "dark");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn settings_unknown_key_is_ignored_and_preserved() {
        let (db, path) = temp_db();
        db.conn
            .lock()
            .unwrap()
            .execute_batch(
                "INSERT INTO settings(key, value) VALUES
                   ('futureKey', 'keep'),
                   ('contextMessages', '999'),
                   ('theme', 'neon');",
            )
            .expect("seed settings");

        let defaults = db.load_settings().expect("非法已知值回落默认值");
        assert_eq!(defaults.context_messages, 5);
        assert_eq!(defaults.theme, "dark");

        db.save_settings(&AppSettingsDto {
            context_messages: 12,
            theme: "light".into(),
        })
        .expect("save settings");
        let loaded = db.load_settings().expect("load settings");
        assert_eq!(loaded.context_messages, 12);
        assert_eq!(loaded.theme, "light");

        let future: String = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key = 'futureKey'",
                [],
                |row| row.get(0),
            )
            .expect("unknown key 应保留");
        assert_eq!(future, "keep");
        std::fs::remove_file(&path).ok();
    }

    /// 脏值不许静默：读的时候必须**收集成给人看的说明**（界面推诊断面板，日志另有一份）。
    #[test]
    fn settings_dirty_values_are_reported_not_silently_defaulted() {
        let (db, path) = temp_db();
        db.conn
            .lock()
            .unwrap()
            .execute_batch(
                "INSERT INTO settings(key, value) VALUES
                   ('contextMessages', '999'),
                   ('theme', 'neon');",
            )
            .expect("seed settings");

        let (settings, issues) = db.load_settings_report().expect("load report");
        assert_eq!(settings.context_messages, 5, "仍然回落默认值，不能让应用打不开");
        assert_eq!(settings.theme, "dark");
        assert_eq!(issues.len(), 2, "两条脏值都要有说明：{issues:?}");
        assert!(issues.iter().any(|i| i.contains("contextMessages") && i.contains("999")));
        assert!(issues.iter().any(|i| i.contains("theme") && i.contains("neon")));

        // 合法库不该产生任何噪音
        db.save_settings(&AppSettingsDto {
            context_messages: 7,
            theme: "light".into(),
        })
        .expect("save settings");
        let (_, clean) = db.load_settings_report().expect("load report");
        assert!(clean.is_empty(), "合法值不该被报成脏值：{clean:?}");
        std::fs::remove_file(&path).ok();
    }

    fn user(id: &str, handle: &str, session: &str) -> AgentUserRow {
        AgentUserRow {
            id: id.into(),
            profile_id: "p1".into(),
            acp_session_id: session.into(),
            name: format!("玩家{id}"),
            handle: handle.into(),
            color: "#8ab4f8".into(),
            created_at: 1,
        }
    }

    #[test]
    fn agent_user_的_handle_大小写不敏感且唯一() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        db.upsert_agent_user(&user("u1", "backend", "s-acp-1"))
            .unwrap();
        // 大小写不同不算另一个人：@BackEnd 和 @backend 会打给同一个人
        let err = db
            .upsert_agent_user(&user("u2", "BackEnd", "s-acp-2"))
            .unwrap_err();
        assert!(err.to_string().contains("handle"), "got: {err}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 同一连接的同一个会话只能是一个玩家() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        db.upsert_agent_user(&user("u1", "a", "s-acp-1")).unwrap();
        // 两个人其实是同一个会话 → 群聊语义当场崩，必须拒绝
        let err = db
            .upsert_agent_user(&user("u2", "b", "s-acp-1"))
            .unwrap_err();
        assert!(err.to_string().contains("acp_session_id"), "got: {err}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 群成员可以重复拉且能移出() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        let s = SessionUpsert {
            id: "s1".into(),
            acp_session_id: None,
            mode_override: None,
            profile_id: Some("p1".into()),
            title: "群".into(),
            cwd: "/tmp".into(),
            created_at: 1,
            updated_at: 1,
        };
        db.upsert_session(&s).unwrap();
        db.upsert_agent_user(&user("u1", "a", "s-acp-1")).unwrap();

        db.add_member("s1", "u1").unwrap();
        db.add_member("s1", "u1").unwrap(); // 幂等：重复拉不是错误
        assert_eq!(db.session_members("s1").unwrap().len(), 1);

        db.remove_member("s1", "u1").unwrap();
        assert!(db.session_members("s1").unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn 消息带作者_读回来还在() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).unwrap();
        let s = SessionUpsert {
            id: "s1".into(),
            acp_session_id: None,
            mode_override: None,
            profile_id: Some("p1".into()),
            title: "群".into(),
            cwd: "/tmp".into(),
            created_at: 1,
            updated_at: 1,
        };
        db.upsert_session(&s).unwrap();
        db.append_messages(
            "s1",
            &[MessageInput {
                id: "m1".into(),
                role: "player".into(),
                kind: "text".into(),
                payload: serde_json::json!({"text": "在"}),
                author_id: Some("u1".into()),
            }],
        )
        .unwrap();
        let rows = db.load_messages("s1", 10).unwrap();
        assert_eq!(rows[0].author_id.as_deref(), Some("u1"));
        let _ = std::fs::remove_file(path);
    }

    fn sample() -> ProfileDto {
        ProfileDto {
            id: "p1".into(),
            name: "Hermes (WSL)".into(),
            launch: "wsl".into(),
            program: "hermes".into(),
            args: vec!["acp".into()],
            cwd: "/mnt/c/source/sincearc".into(),
            default_mode: None,
            caps: None,
            caps_at: None,
            distro: Some("fedora".into()),
            shell: Some("zsh".into()),
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth: None,
            ssh_key_path: None,
            ssh_password: Some("must-not-persist".into()),
        }
    }

    /// 写入用的模型（只含真实列）
    fn session(id: &str, acp: Option<&str>) -> SessionUpsert {
        SessionUpsert {
            id: id.into(),
            acp_session_id: acp.map(|s| s.to_string()),
            mode_override: None,
            profile_id: Some("p1".into()),
            title: "新会话".into(),
            cwd: "/mnt/c/source/sincearc".into(),
            created_at: now(),
            updated_at: now(),
        }
    }

    /// 测试专用：把会话放在指定秒数上，分组/排序都只看 updated_at。
    fn session_at(id: &str, updated_at: i64) -> SessionUpsert {
        let mut row = session(id, None);
        row.created_at = updated_at;
        row.updated_at = updated_at;
        row
    }

    fn acp_state(db: &Db, id: &str) -> Option<String> {
        let conn = db.conn.lock().expect("db poisoned");
        conn.query_row(
            "SELECT acp_state FROM sessions WHERE id = ?1",
            params![id],
            |r| r.get::<_, Option<String>>(0),
        )
        .expect("acp_state")
    }

    #[test]
    fn profiles_round_trip_and_passwords_are_dropped() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        let loaded = db.load_profiles().expect("load");
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].ssh_password.is_none());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn sessions_are_listed_newest_first_and_cascade_on_profile_delete() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-old", Some("acp-1")))
            .expect("s1");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        db.upsert_session(&session("s-new", None)).expect("s2");

        let list = db.list_sessions(None).expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "s-new", "最近的排前面");

        // 删配置 -> 它的会话一起没了
        db.save_profiles(&[]).expect("clear");
        assert!(db.list_sessions(None).expect("list").is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn day_bucket_today_yesterday_earlier() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        let now = now();
        for (id, updated_at) in [
            ("s-today", now),
            // 日历日语义：now - 86400 在绝大多数时区都是昨天；若测试恰逢
            // 时区切换/零点边界，下面断言会打印实际 bucket 与 now 便于判断。
            ("s-yesterday", now - 86_400),
            ("s-earlier", now - 10 * 86_400),
        ] {
            db.upsert_session(&session_at(id, updated_at))
                .expect("insert session");
        }

        let rows = db.list_sessions(None).expect("list");
        let row = |id: &str| {
            rows.iter()
                .find(|r| r.id == id)
                .unwrap_or_else(|| panic!("missing {id}; now={now}"))
        };
        assert_eq!(
            row("s-today").day_bucket,
            "today",
            "today bucket; now={now}"
        );
        assert_eq!(
            row("s-yesterday").day_bucket,
            "yesterday",
            "yesterday bucket; now={now}"
        );
        assert_eq!(
            row("s-earlier").day_bucket,
            "earlier",
            "earlier bucket; now={now}"
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn display_time_is_time_for_today_and_date_before() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        let now = now();
        db.upsert_session(&session_at("s-today", now))
            .expect("insert today");
        db.upsert_session(&session_at("s-earlier", now - 10 * 86_400))
            .expect("insert earlier");

        let rows = db.list_sessions(None).expect("list");
        let row = |id: &str| {
            rows.iter()
                .find(|r| r.id == id)
                .unwrap_or_else(|| panic!("missing {id}; now={now}"))
        };
        let shape = |value: &str, sep: u8| {
            value.len() == 5
                && value.as_bytes()[2] == sep
                && value
                    .as_bytes()
                    .iter()
                    .enumerate()
                    .all(|(i, b)| i == 2 || b.is_ascii_digit())
        };
        assert!(
            shape(&row("s-today").display_time, b':'),
            "today display_time={} now={now}",
            row("s-today").display_time
        );
        assert!(
            shape(&row("s-earlier").display_time, b'-'),
            "earlier display_time={} now={now}",
            row("s-earlier").display_time
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn list_still_orders_newest_first() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        let now = now();
        for (id, updated_at) in [
            ("s-old", now - 10 * 86_400),
            ("s-mid", now - 86_400),
            ("s-new", now),
        ] {
            db.upsert_session(&session_at(id, updated_at))
                .expect("insert session");
        }

        let ids: Vec<String> = db
            .list_sessions(None)
            .expect("list")
            .into_iter()
            .map(|r| r.id)
            .collect();
        let expected: Vec<String> = ["s-new", "s-mid", "s-old"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert_eq!(ids, expected, "now={now}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn binding_an_acp_session_survives_a_null_upsert() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");
        db.bind_acp_session("s-1", "local-abc", "/tmp", "created")
            .expect("bind");
        // 之后再 upsert 一次（acp 为空）不能把绑定冲掉
        db.upsert_session(&session("s-1", None)).expect("upsert");
        let list = db.list_sessions(None).expect("list");
        assert_eq!(list[0].acp_session_id.as_deref(), Some("local-abc"));
        assert_eq!(
            db.last_acp_session("p1").expect("last").as_deref(),
            Some("local-abc")
        );
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn bind_records_history_and_supersedes_previous() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        db.bind_acp_session("s-1", "acp-a", "/work", "created")
            .expect("bind a");
        db.bind_acp_session("s-1", "acp-b", "/work", "loaded")
            .expect("bind b");

        let rows = db.bindings("s-1").expect("bindings");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].acp_session_id, "acp-b");
        assert_eq!(rows[0].reason, "loaded");
        assert!(rows[0].superseded_at.is_none());
        assert_eq!(rows[1].acp_session_id, "acp-a");
        assert!(rows[1].superseded_at.is_some());
        assert_eq!(rows.iter().filter(|r| r.superseded_at.is_none()).count(), 1);

        let list = db.list_sessions(None).expect("list");
        assert_eq!(list[0].acp_session_id.as_deref(), Some("acp-b"));
        assert_eq!(acp_state(&db, "s-1").as_deref(), Some("ok"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn binding_same_id_twice_is_idempotent() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        db.bind_acp_session("s-1", "acp-a", "/work", "created")
            .expect("bind first");
        db.bind_acp_session("s-1", "acp-a", "/work", "loaded")
            .expect("bind again");

        let rows = db.bindings("s-1").expect("bindings");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].reason, "created");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mark_invalid_keeps_the_credential() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", Some("acp-credential")))
            .expect("insert");

        db.mark_acp_invalid("s-1").expect("mark invalid");

        let list = db.list_sessions(None).expect("list");
        assert_eq!(list[0].acp_session_id.as_deref(), Some("acp-credential"));
        assert_eq!(acp_state(&db, "s-1").as_deref(), Some("invalid"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn deleting_a_session_cascades_to_bindings() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");
        db.bind_acp_session("s-1", "acp-a", "/work", "created")
            .expect("bind");

        assert_eq!(db.bindings("s-1").expect("before").len(), 1);
        db.delete_session("s-1").expect("delete");
        assert!(db.bindings("s-1").expect("after").is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn first_user_message_becomes_the_session_title() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let user = |id: &str, text: &str| MessageInput {
            id: id.into(),
            author_id: None,
            role: "user".into(),
            kind: "text".into(),
            payload: serde_json::json!({ "id": id, "text": text }),
        };
        db.append_messages("s-1", &[user("u1", "第一行标题\n第二行不要")])
            .expect("a");
        // db 不知道「标题该怎么来」：调用方给什么就写什么（业务规则在 commands 层）
        let n = db
            .set_title_if_unnamed("s-1", "第一行标题", &["新会话"])
            .expect("title");
        assert_eq!(n, 1, "占位名可被覆盖");
        assert_eq!(db.list_sessions(None).expect("list")[0].title, "第一行标题");

        // 已有真实标题就不再覆盖
        let n2 = db
            .set_title_if_unnamed("s-1", "第二条完全不同的话", &["新会话"])
            .expect("title2");
        assert_eq!(n2, 0, "非占位名不许改");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn messages_append_in_order_and_reload_ascending() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let mk = |id: &str, text: &str| MessageInput {
            id: id.into(),
            author_id: None,
            role: "player".into(),
            kind: "text".into(),
            payload: serde_json::json!({ "id": id, "text": text }),
        };
        db.append_messages("s-1", &[mk("m1", "第一句")]).expect("a");
        db.append_messages("s-1", &[mk("m2", "第二句")]).expect("b");

        // 同一条再写一次（流式定稿会重复调用），不应该多出一行
        db.append_messages("s-1", &[mk("m2", "第二句（更新）")])
            .expect("b2");

        let rows = db.load_messages("s-1", 50).expect("load");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].seq, 1);
        assert_eq!(rows[1].seq, 2);
        assert_eq!(rows[1].payload["text"], "第二句（更新）");

        // 会话被删 -> 消息跟着走
        db.delete_session("s-1").expect("del");
        assert!(db.load_messages("s-1", 50).expect("load").is_empty());
        std::fs::remove_file(&path).ok();
    }

    fn seed_sixty_messages(db: &Db) {
        let messages: Vec<MessageInput> = (1..=60)
            .map(|i| MessageInput {
                id: format!("m{i}"),
                author_id: None,
                role: if i % 2 == 0 { "player" } else { "user" }.into(),
                kind: "text".into(),
                payload: serde_json::json!({ "id": format!("m{i}"), "text": format!("第{i}条") }),
            })
            .collect();
        db.append_messages("s-1", &messages).expect("seed");
    }

    #[test]
    fn page_returns_latest_and_flags_more() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");
        seed_sixty_messages(&db);

        let page = db
            .load_messages_page("s-1", 50, None)
            .expect("latest page");
        assert_eq!(page.messages.len(), 50);
        assert!(page.has_more);
        assert_eq!(page.messages.first().expect("first").seq, 11);
        assert_eq!(page.messages.last().expect("last").seq, 60);
        assert_eq!(page.messages.last().expect("last").id, "m60");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn page_cursor_returns_older_without_overlap() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");
        seed_sixty_messages(&db);

        let latest = db
            .load_messages_page("s-1", 50, None)
            .expect("latest page");
        let cursor = latest.messages.first().expect("oldest latest").seq;
        let older = db
            .load_messages_page("s-1", 50, Some(cursor))
            .expect("older page");

        assert_eq!(older.messages.len(), 10);
        assert!(!older.has_more);
        let latest_ids: std::collections::HashSet<_> =
            latest.messages.iter().map(|m| m.id.as_str()).collect();
        assert!(older
            .messages
            .iter()
            .all(|m| !latest_ids.contains(m.id.as_str())));
        assert!(older.messages.iter().all(|m| m.seq < cursor));
        assert!(older
            .messages
            .windows(2)
            .all(|pair| pair[0].seq < pair[1].seq));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn page_on_empty_session() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let page = db
            .load_messages_page("s-1", 50, None)
            .expect("empty page");
        assert!(page.messages.is_empty());
        assert!(!page.has_more);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn events_are_appended_in_order_and_die_with_the_session() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let ev = |kind: &str, turn: &str| EventInput {
            turn_id: turn.into(),
            author_id: None,
            kind: kind.into(),
            payload_json: r#"{"text":"x"}"#.into(),
            source: "live".into(),
            truncated: false,
        };
        db.append_events("s-1", &[ev("thought", "t1")]).expect("e1");
        db.append_events(
            "s-1",
            &[ev("tool_call", "t1"), ev("permission", "t2")],
        )
        .expect("e2");

        let rows = db.load_events("s-1", 50).expect("load");
        // 倒序返回：最新的在前
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].seq, 3);
        assert_eq!(rows[0].kind, "permission");
        assert_eq!(rows[0].turn_id, "t2");
        assert_eq!(rows[2].seq, 1);
        assert_eq!(rows[2].kind, "thought");

        // 删会话要连轨迹一起删：否则库里留下没人能看的孤儿行
        db.delete_session("s-1").expect("delete");
        assert!(db.load_events("s-1", 50).expect("load2").is_empty());

        std::fs::remove_file(&path).ok();
    }


    #[test]
    fn turns_record_prompt_and_finish_state() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        db.start_turn("s-1", "t1", "现在几点", None).expect("start");
        db.start_turn("s-1", "t2", "写个文件", None).expect("start2");
        db.end_turn("t2", "failed", Some("timeout: timed out after 120s"))
            .expect("end");

        let turns = db.load_turns("s-1", 10).expect("load");
        assert_eq!(turns.len(), 2);
        // 倒序：最新一轮在前
        assert_eq!(turns[0].id, "t2");
        assert_eq!(turns[0].status, "failed");
        assert!(turns[0].ended_at.is_some());
        // 没收到结束的轮次保持 running —— 界面据此显示「还在跑」
        assert_eq!(turns[1].status, "running");
        assert!(turns[1].ended_at.is_none());
        assert_eq!(turns[1].prompt, "现在几点");

        db.delete_session("s-1").expect("del");
        assert!(db.load_turns("s-1", 10).expect("load2").is_empty());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn cancelled_turn_keeps_partial_text_and_status() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        db.start_turn("s-1", "t-cancel", "继续写", None)
            .expect("start");
        db.append_messages(
            "s-1",
            &[MessageInput {
                id: "partial-1".into(),
                author_id: None,
                role: "player".into(),
                kind: "text".into(),
                payload: serde_json::json!({ "id": "partial-1", "text": "写了一半" }),
            }],
        )
        .expect("append partial");
        db.end_turn("t-cancel", "cancelled", Some("cancelled"))
            .expect("end cancelled");

        let turns = db.load_turns("s-1", 10).expect("load turns");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].status, "cancelled");
        assert_eq!(turns[0].stop_reason.as_deref(), Some("cancelled"));
        assert!(turns[0].ended_at.is_some());

        let messages = db.load_messages("s-1", 10).expect("load messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].payload["text"], "写了一半");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn turn_moves_through_waiting_approval_and_records_stop_reason() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        db.start_turn("s-1", "t1", "改个文件", None).expect("start");
        assert_eq!(
            db.load_turns("s-1", 1).expect("running")[0].status,
            "running"
        );

        assert_eq!(
            db.mark_turn_waiting_approval("t1").expect("waiting"),
            1
        );
        assert_eq!(
            db.load_turns("s-1", 1).expect("waiting row")[0].status,
            "waiting_approval"
        );

        assert_eq!(
            db.resume_turn_after_approval("t1").expect("resume"),
            1
        );
        assert_eq!(
            db.load_turns("s-1", 1).expect("resumed row")[0].status,
            "running"
        );

        db.end_turn("t1", "finished", Some("end_turn"))
            .expect("end finished");
        let turns = db.load_turns("s-1", 1).expect("finished row");
        assert_eq!(turns[0].status, "finished");
        assert_eq!(turns[0].stop_reason.as_deref(), Some("end_turn"));
        assert!(turns[0].ended_at.is_some());

        // 已结束的轮不能再被权限回包改回 running
        assert_eq!(
            db.resume_turn_after_approval("t1").expect("no-op resume"),
            0
        );
        // 也不能被迟到的权限请求重新标成 waiting_approval
        assert_eq!(
            db.mark_turn_waiting_approval("t1")
                .expect("no-op waiting"),
            0
        );

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn failed_turn_records_non_empty_stop_reason() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        db.start_turn("s-1", "t-fail", "跑一下", None)
            .expect("start");
        db.end_turn(
            "t-fail",
            "failed",
            Some("-32603: agent returned error: boom"),
        )
        .expect("end failed");

        let turns = db.load_turns("s-1", 1).expect("load");
        assert_eq!(turns[0].status, "failed");
        assert!(
            turns[0]
                .stop_reason
                .as_deref()
                .is_some_and(|reason| !reason.is_empty()),
            "失败轮必须留下可解释的原因"
        );
        assert!(turns[0].ended_at.is_some());

        std::fs::remove_file(&path).ok();
    }


    #[test]
    fn prune_drops_old_and_over_cap_traces_but_keeps_running_turns() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("save");
        db.upsert_session(&session("s-1", None)).expect("insert");

        let ev = |kind: &str, turn: &str| EventInput {
            turn_id: turn.into(),
            author_id: None,
            kind: kind.into(),
            payload_json: "{}".into(),
            source: "live".into(),
            truncated: false,
        };
        // 60 条：验证「单会话只留最近 N 条」
        db.start_turn("s-1", "t-new", "新的一轮", None).expect("turn");
        for _ in 0..60 {
            db.append_events("s-1", &[ev("thought", "t-new")]).expect("e");
        }
        // 一个正在跑的轮次（不收尾）：它的事件清空后，轮次本身不能被删
        db.start_turn("s-1", "t-running", "还在跑", None).expect("turn2");
        // 等用户批准的轮次同样还没收尾，不能当成「没有事件的历史轮」清掉
        db.start_turn("s-1", "t-waiting", "等你批准", None)
            .expect("turn3");
        db.mark_turn_waiting_approval("t-waiting")
            .expect("waiting");

        let report = db
            .prune_traces(crate::trace::now_ms() - 90 * 24 * 3600 * 1000, 50, false)
            .expect("prune");
        assert_eq!(report.events_deleted, 10, "60 条里只该删掉最早的 10 条");
        let left = db.load_events("s-1", 500).expect("load");
        assert_eq!(left.len(), 50);
        // 最老的 seq 已被删掉
        assert_eq!(left.iter().map(|e| e.seq).min(), Some(11));

        // running 的轮次不许被清理逻辑带走
        let turns = db.load_turns("s-1", 10).expect("turns");
        assert!(turns.iter().any(|t| t.id == "t-running" && t.status == "running"));
        assert!(turns
            .iter()
            .any(|t| t.id == "t-waiting" && t.status == "waiting_approval"));

        // 全部事件都过期时，事件与轮次一起清掉
        // cutoff 在未来 = 会清空全部：不带 allow_wipe 时必须被挡下
        let blocked = db
            .prune_traces(crate::trace::now_ms() + 1000, 50, false)
            .expect("blocked");
        assert_eq!(blocked.events_deleted, 0, "一次性清空必须先被防呆挡住");
        assert_eq!(db.load_events("s-1", 500).expect("still").len(), 50);
        let report2 = db
            .prune_traces(crate::trace::now_ms() + 1000, 50, true)
            .expect("prune2");
        assert_eq!(report2.events_deleted, 50);
        assert!(report2.turns_deleted >= 1);
        assert!(db.load_events("s-1", 500).expect("l3").is_empty());
        // 时间过滤会带走它：一轮 90 天还没收尾，说明那次运行已经死了，留着只会显示「永远在跑」
        assert!(db.load_turns("s-1", 10).expect("t3").is_empty());

        std::fs::remove_file(&path).ok();
    }

    // ---------- E13.7 可恢复句柄 ----------

    /// 会话行只是外键落点，句柄测试不关心它的语义。
    fn seed_session(db: &Db, id: &str) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO sessions (id, acp_session_id, profile_id, title, cwd, created_at, updated_at)
                 VALUES (?1, NULL, NULL, 't', '/w', 1, 1)",
                params![id],
            )
            .expect("seed session");
    }

    #[test]
    fn live_handle_roundtrips_and_old_binding_is_superseded() {
        let (db, path) = temp_db();
        seed_session(&db, "s-h1");

        db.bind_acp_session_with_agent("s-h1", "acp-1", "/w", "created", Some("hermes"))
            .expect("bind");
        let h = db.live_handle("s-h1").expect("read").expect("有句柄");
        assert_eq!(h.acp_session_id, "acp-1");
        assert_eq!(h.agent_name.as_deref(), Some("hermes"));
        assert_eq!(h.last_event_seq, None, "刚绑定还没有事件水位");

        // 水位只升不降：乱序/重放的 touch 不能让它倒退
        db.touch_handle_seq("s-h1", "acp-1", 7).expect("seq7");
        db.touch_handle_seq("s-h1", "acp-1", 3).expect("seq3");
        assert_eq!(db.live_handle("s-h1").unwrap().unwrap().last_event_seq, Some(7));

        // 换 acp id = 新绑定，旧行 superseded；新行不继承旧水位
        db.bind_acp_session_with_agent("s-h1", "acp-2", "/w", "replaced", Some("hermes"))
            .expect("rebind");
        let h2 = db.live_handle("s-h1").unwrap().expect("新句柄");
        assert_eq!(h2.acp_session_id, "acp-2");
        assert_eq!(h2.last_event_seq, None);
        assert_eq!(db.bindings("s-h1").unwrap().len(), 2, "旧绑定留着做审计");

        // 拿已被顶替的 acp id 写水位，不应串到 live 行上
        db.touch_handle_seq("s-h1", "acp-1", 99).expect("stale touch");
        assert_eq!(db.live_handle("s-h1").unwrap().unwrap().last_event_seq, None);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn rebinding_same_acp_id_keeps_agent_name_and_watermark() {
        let (db, path) = temp_db();
        seed_session(&db, "s-h2");
        db.bind_acp_session_with_agent("s-h2", "acp-1", "/w", "created", Some("hermes"))
            .expect("bind");
        db.touch_handle_seq("s-h2", "acp-1", 12).expect("seq");

        // 前端连接成功后会幂等再绑一次，且不带 agent 名 —— 不能把已有信息洗掉
        db.bind_acp_session("s-h2", "acp-1", "/w2", "created").expect("rebind");
        let h = db.live_handle("s-h2").unwrap().unwrap();
        assert_eq!(h.agent_name.as_deref(), Some("hermes"));
        assert_eq!(h.last_event_seq, Some(12));
        assert_eq!(h.cwd, "/w2");

        // 前端 session_bind_acp 只带空 cwd；空串不能把真实工作目录洗掉。
        db.bind_acp_session("s-h2", "acp-1", "", "replaced").expect("empty cwd");
        let h = db.live_handle("s-h2").unwrap().unwrap();
        assert_eq!(h.cwd, "/w2");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn appending_events_advances_the_live_handle_watermark() {
        let (db, path) = temp_db();
        seed_session(&db, "s-h3");
        db.bind_acp_session_with_agent("s-h3", "acp-1", "/w", "created", Some("hermes"))
            .expect("bind");
        let ev = |turn: &str| EventInput {
            turn_id: turn.into(),
            author_id: None,
            kind: "thought".into(),
            payload_json: r#"{"text":"x"}"#.into(),
            source: "live".into(),
            truncated: false,
        };

        // 同一批多写几条也只落最终 seq；不额外开事务。
        db.append_events("s-h3", &[ev("t1"), ev("t1")]).expect("append");
        assert_eq!(db.live_handle("s-h3").unwrap().unwrap().last_event_seq, Some(2));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn old_binding_table_gains_handle_columns() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-db-handle-mig-{}-{nanos}.db",
            std::process::id()
        ));
        {
            // E13.7 之前的表：只有 acp id / cwd / reason，没有 agent_name 与水位
            let conn = Connection::open(&path).expect("old db");
            conn.execute_batch(
                "CREATE TABLE sessions (
                   id TEXT PRIMARY KEY, acp_session_id TEXT, profile_id TEXT,
                   title TEXT NOT NULL DEFAULT '新会话', cwd TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO sessions (id, acp_session_id, title, cwd, created_at, updated_at)
                   VALUES ('s-old', 'acp-old', '老会话', '/w', 1, 1);
                 CREATE TABLE session_bindings (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   session_id TEXT NOT NULL,
                   acp_session_id TEXT NOT NULL,
                   cwd TEXT NOT NULL DEFAULT '',
                   bound_at INTEGER NOT NULL,
                   reason TEXT NOT NULL,
                   superseded_at INTEGER);
                 INSERT INTO session_bindings (session_id, acp_session_id, cwd, bound_at, reason)
                   VALUES ('s-old', 'acp-old', '/w', 1, 'created');",
            )
            .expect("seed old binding table");
        }

        let db = Db::open(&path).expect("旧库应能打开并补列");
        let h = db.live_handle("s-old").expect("read").expect("老绑定仍是 live");
        assert_eq!(h.acp_session_id, "acp-old");
        assert_eq!(h.agent_name, None, "老数据没有 agent 名，不能凭空编一个");
        assert_eq!(h.last_event_seq, None);
        db.touch_handle_seq("s-old", "acp-old", 5).expect("新列可写");
        assert_eq!(db.live_handle("s-old").unwrap().unwrap().last_event_seq, Some(5));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn save_profile_caps_round_trips() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("seed profile");

        let caps = AgentCaps {
            load_session: true,
            prompt_image: true,
            session_fork: true,
            ..AgentCaps::default()
        };
        let json = serde_json::to_string(&caps).expect("serialize caps");

        db.save_profile_caps("p1", &json, 1_700_000_000)
            .expect("save caps");

        let rows = db.load_profiles().expect("load profiles");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].caps.as_ref(), Some(&caps));
        assert_eq!(rows[0].caps_at, Some(1_700_000_000));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn 命令或环境变了就作废旧的能力快照() {
        let (db, path) = temp_db();
        db.save_profiles(&[sample()]).expect("seed profile");
        let caps = AgentCaps {
            load_session: true,
            ..AgentCaps::default()
        };
        let json = serde_json::to_string(&caps).expect("serialize");
        db.save_profile_caps("p1", &json, 100).expect("save caps");

        // 只改名字（身份字段）：握手结论必须留着，否则用户改个名字就得重连一次
        let mut renamed = sample();
        renamed.name = "改个名字".into();
        db.save_profiles(&[renamed]).expect("save renamed");
        assert!(
            db.load_profiles().expect("load")[0].caps.is_some(),
            "改名字不该作废能力快照"
        );

        // 换命令（会话字段）：旧快照立刻作废，面板不许再拿它描述这条新命令
        let mut changed = sample();
        changed.program = "codex".into();
        db.save_profiles(&[changed]).expect("save changed");
        let row = db.load_profiles().expect("load");
        assert!(row[0].caps.is_none(), "换了命令，旧握手结论必须作废");
        assert!(row[0].caps_at.is_none(), "作废时时间戳一起清");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn save_profile_caps_rejects_unknown_profile() {
        let (db, path) = temp_db();
        let err = db
            .save_profile_caps("missing", "{}", 1)
            .expect_err("不存在的 profile 不能静默成功");
        assert!(matches!(err, DbError::ProfileNotFound(id) if id == "missing"));

        std::fs::remove_file(&path).ok();
    }

}
