//! MCP 目录与三层名单（docs/mcp.md）。
//!
//! 目录是全局唯一的一份配置；profile / session 只存名字。解析规则永远是
//! `session ?? profile ?? 目录 enabled`，不做合并：NULL 表示继承，`[]` 表示明确为空。

use std::collections::HashSet;

use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};

use crate::commands::CmdError;
use crate::state::AppState;

const CATALOG_MAX: usize = 64;
const EFFECTIVE_MAX: usize = 32;
const NAME_MAX_CHARS: usize = 64;
const PAIRS_MAX: usize = 32;
const VALUE_MAX_BYTES: usize = 4 * 1024;

pub(crate) type McpRow = (String, String, String, bool, i64);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct McpKeyValueDto {
    pub name: String,
    pub value: String,
}

/// 协议里的三种 MCP server 形态。
///
/// stdio 没有 `type`（缺省形态）；http / sse 必须有 `"type"`。默认的 enum 表示会
/// 包成 `{"Stdio":{...}}`，所以这里手写 serde，保证报文逐字段是协议形状。
#[derive(Debug, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum McpServerDto {
    Stdio {
        name: String,
        command: String,
        args: Vec<String>,
        env: Vec<McpKeyValueDto>,
    },
    Http {
        name: String,
        url: String,
        headers: Vec<McpKeyValueDto>,
    },
    Sse {
        name: String,
        url: String,
        headers: Vec<McpKeyValueDto>,
    },
}

impl McpServerDto {
    pub fn name(&self) -> &str {
        match self {
            Self::Stdio { name, .. } | Self::Http { name, .. } | Self::Sse { name, .. } => name,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Stdio { .. } => "stdio",
            Self::Http { .. } => "http",
            Self::Sse { .. } => "sse",
        }
    }

    fn with_trimmed_name(self) -> Self {
        match self {
            Self::Stdio {
                name,
                command,
                args,
                env,
            } => Self::Stdio {
                name: name.trim().to_string(),
                command,
                args,
                env,
            },
            Self::Http {
                name,
                url,
                headers,
            } => Self::Http {
                name: name.trim().to_string(),
                url,
                headers,
            },
            Self::Sse {
                name,
                url,
                headers,
            } => Self::Sse {
                name: name.trim().to_string(),
                url,
                headers,
            },
        }
    }
}

impl Serialize for McpServerDto {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::Stdio {
                name,
                command,
                args,
                env,
            } => {
                map.serialize_entry("name", name)?;
                map.serialize_entry("command", command)?;
                map.serialize_entry("args", args)?;
                map.serialize_entry("env", env)?;
            }
            Self::Http {
                name,
                url,
                headers,
            } => {
                map.serialize_entry("type", "http")?;
                map.serialize_entry("name", name)?;
                map.serialize_entry("url", url)?;
                map.serialize_entry("headers", headers)?;
            }
            Self::Sse {
                name,
                url,
                headers,
            } => {
                map.serialize_entry("type", "sse")?;
                map.serialize_entry("name", name)?;
                map.serialize_entry("url", url)?;
                map.serialize_entry("headers", headers)?;
            }
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for McpServerDto {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("MCP server 必须是 JSON 对象"))?;
        let kind = match object.get("type") {
            None => "stdio",
            Some(Value::String(kind)) => kind.as_str(),
            Some(_) => {
                return Err(serde::de::Error::custom(
                    "MCP server 的 type 必须是字符串",
                ))
            }
        };

        let name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| serde::de::Error::missing_field("name"))?
            .to_string();

        match kind {
            "stdio" => {
                let command = object
                    .get("command")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::missing_field("command"))?
                    .to_string();
                let args = match object.get("args") {
                    Some(raw) => serde_json::from_value::<Vec<String>>(raw.clone())
                        .map_err(serde::de::Error::custom)?,
                    None => Vec::new(),
                };
                let env = match object.get("env") {
                    Some(raw) => serde_json::from_value::<Vec<McpKeyValueDto>>(raw.clone())
                        .map_err(serde::de::Error::custom)?,
                    None => Vec::new(),
                };
                Ok(Self::Stdio {
                    name,
                    command,
                    args,
                    env,
                })
            }
            "http" => Ok(Self::Http {
                name,
                url: object
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::missing_field("url"))?
                    .to_string(),
                headers: match object.get("headers") {
                    Some(raw) => serde_json::from_value::<Vec<McpKeyValueDto>>(raw.clone())
                        .map_err(serde::de::Error::custom)?,
                    None => Vec::new(),
                },
            }),
            "sse" => Ok(Self::Sse {
                name,
                url: object
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or_else(|| serde::de::Error::missing_field("url"))?
                    .to_string(),
                headers: match object.get("headers") {
                    Some(raw) => serde_json::from_value::<Vec<McpKeyValueDto>>(raw.clone())
                        .map_err(serde::de::Error::custom)?,
                    None => Vec::new(),
                },
            }),
            other => Err(serde::de::Error::custom(format!(
                "未知的 MCP server type：{other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct McpCatalogEntryDto {
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub server: McpServerDto,
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub struct SessionMcpStateDto {
    pub session_names: Option<Vec<String>>,
    pub profile_names: Option<Vec<String>>,
    pub effective: Vec<McpCatalogEntryDto>,
}

pub fn validate_mcp_server(server: &McpServerDto) -> Result<(), CmdError> {
    let name = server.name().trim();
    if name.is_empty() {
        return Err(CmdError::new(50700, "MCP 名称不能为空"));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(CmdError::new(
            50700,
            format!("MCP 名称不能超过 {NAME_MAX_CHARS} 个字符"),
        ));
    }

    match server {
        McpServerDto::Stdio {
            command, args, env, ..
        } => {
            if command.trim().is_empty() {
                return Err(CmdError::new(50700, "stdio 的 command 不能为空"));
            }
            for (index, arg) in args.iter().enumerate() {
                if arg.trim().is_empty() {
                    return Err(CmdError::new(
                        50700,
                        format!("stdio 的 args 第 {} 项不能为空", index + 1),
                    ));
                }
            }
            validate_pairs("stdio 的 env", env)?;
        }
        McpServerDto::Http { url, headers, .. } => {
            validate_url("http", url)?;
            validate_pairs("http 的 headers", headers)?;
        }
        McpServerDto::Sse { url, headers, .. } => {
            validate_url("sse", url)?;
            validate_pairs("sse 的 headers", headers)?;
        }
    }
    Ok(())
}

fn validate_url(kind: &str, url: &str) -> Result<(), CmdError> {
    let url = url.trim();
    if url.is_empty() {
        return Err(CmdError::new(50700, format!("{kind} 的 url 不能为空")));
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(CmdError::new(
            50700,
            format!("{kind} 的 url 必须以 http:// 或 https:// 开头"),
        ));
    }
    Ok(())
}

fn validate_pairs(field: &str, pairs: &[McpKeyValueDto]) -> Result<(), CmdError> {
    if pairs.len() > PAIRS_MAX {
        return Err(CmdError::new(
            50700,
            format!("{field} 最多 {PAIRS_MAX} 项"),
        ));
    }
    for (index, pair) in pairs.iter().enumerate() {
        if pair.value.len() > VALUE_MAX_BYTES {
            return Err(CmdError::new(
                50700,
                format!("{field}[{index}].value 超过 4KB"),
            ));
        }
    }
    Ok(())
}

pub(crate) fn catalog_entries(rows: &[McpRow]) -> Vec<McpCatalogEntryDto> {
    let mut entries = Vec::with_capacity(rows.len());
    for (name, kind, config_json, enabled, _) in rows {
        match row_to_entry(name.clone(), kind.clone(), config_json, *enabled) {
            Some(entry) => entries.push(entry),
            None => tracing::warn!(
                target: "sincearc::mcp",
                name = %name,
                kind = %kind,
                "MCP 目录条目的配置无法解析，已忽略"
            ),
        }
    }
    entries
}

pub(crate) fn upsert_server(
    state: &AppState,
    server: McpServerDto,
    enabled: bool,
) -> Result<(), CmdError> {
    validate_mcp_server(&server)?;
    let server = server.with_trimmed_name();
    let rows = catalog_rows(state)?;
    let is_new = !rows.iter().any(|row| row.0 == server.name());
    if is_new && rows.len() >= CATALOG_MAX {
        return Err(CmdError::new(
            50700,
            format!("MCP 目录最多 {CATALOG_MAX} 条"),
        ));
    }
    let config = config_json(&server)?;
    state
        .db
        .upsert_mcp_server(server.name(), server.kind(), &config, enabled)
        .map_err(|e| CmdError::new(50000, format!("保存 MCP 目录失败：{e}")))
}

pub(crate) fn delete_server(state: &AppState, name: &str) -> Result<(), CmdError> {
    state
        .db
        .delete_mcp_server(name.trim())
        .map_err(|e| CmdError::new(50000, format!("删除 MCP 目录失败：{e}")))
}

pub(crate) async fn session_mcp_names(
    state: &AppState,
    ui_session_id: &str,
) -> Result<Vec<String>, CmdError> {
    let rows = catalog_rows(state)?;
    session_names_from_state(state, &rows, ui_session_id)
}

pub(crate) async fn session_mcp_servers(
    state: &AppState,
    ui_session_id: &str,
) -> Result<Vec<Value>, CmdError> {
    let names = session_mcp_names(state, ui_session_id).await?;
    let rows = catalog_rows(state)?;
    let entries = entries_for_names(&rows, &names, "本会话")?;
    entry_values(entries)
}

pub(crate) async fn profile_mcp_servers(
    state: &AppState,
    profile_id: &str,
) -> Result<Vec<Value>, CmdError> {
    let rows = catalog_rows(state)?;
    let names = profile_names_from_state(state, &rows, profile_id)?;
    let entries = entries_for_names(&rows, &names, "本连接")?;
    entry_values(entries)
}

/// 有 UI 会话就取会话级，没有就退回连接级 —— 七个落点共用这一条判断。
pub(crate) async fn target_mcp_servers(
    state: &AppState,
    profile_id: &str,
    ui_session_id: Option<&str>,
) -> Result<Vec<Value>, CmdError> {
    match ui_session_id {
        Some(ui_session_id) => session_mcp_servers(state, ui_session_id).await,
        None => profile_mcp_servers(state, profile_id).await,
    }
}

pub(crate) async fn session_state(
    state: &AppState,
    ui_session_id: &str,
) -> Result<SessionMcpStateDto, CmdError> {
    let rows = catalog_rows(state)?;
    let session_raw = state
        .db
        .session_mcp_names_raw(ui_session_id)
        .map_err(|e| CmdError::new(50000, format!("读取会话 MCP 名单失败：{e}")))?;
    let session_names = match session_raw {
        Some(Some(raw)) => parse_names(&raw, "sessions", ui_session_id),
        _ => None,
    };
    let profile_id = state
        .db
        .session_profile_id(ui_session_id)
        .map_err(|e| CmdError::new(50000, format!("读取会话连接失败：{e}")))?
        .flatten();

    let profile_names = match profile_id.as_deref() {
        Some(profile_id) => {
            let raw = state
                .db
                .profile_default_mcp_raw(profile_id)
                .map_err(|e| CmdError::new(50000, format!("读取连接 MCP 名单失败：{e}")))?;
            match raw {
                Some(Some(raw)) => parse_names(&raw, "profiles", profile_id),
                _ => None,
            }
        }
        None => None,
    };

    let effective_names = if let Some(names) = session_names.as_ref() {
        names.clone()
    } else if let Some(names) = profile_names.as_ref() {
        names.clone()
    } else {
        enabled_names(&rows)
    };
    let effective = entries_for_names(&rows, &effective_names, "本会话")?;

    Ok(SessionMcpStateDto {
        session_names,
        profile_names,
        effective,
    })
}

fn catalog_rows(state: &AppState) -> Result<Vec<McpRow>, CmdError> {
    state
        .db
        .mcp_catalog_rows()
        .map_err(|e| CmdError::new(50000, format!("读取 MCP 目录失败：{e}")))
}

fn session_names_from_state(
    state: &AppState,
    rows: &[McpRow],
    ui_session_id: &str,
) -> Result<Vec<String>, CmdError> {
    let session_raw = state
        .db
        .session_mcp_names_raw(ui_session_id)
        .map_err(|e| CmdError::new(50000, format!("读取会话 MCP 名单失败：{e}")))?;
    if let Some(Some(raw)) = session_raw {
        if let Some(names) = parse_names(&raw, "sessions", ui_session_id) {
            return Ok(names);
        }
    }

    let profile_id = state
        .db
        .session_profile_id(ui_session_id)
        .map_err(|e| CmdError::new(50000, format!("读取会话连接失败：{e}")))?
        .flatten();
    if let Some(profile_id) = profile_id {
        let profile_raw = state
            .db
            .profile_default_mcp_raw(&profile_id)
            .map_err(|e| CmdError::new(50000, format!("读取连接 MCP 名单失败：{e}")))?;
        if let Some(Some(raw)) = profile_raw {
            if let Some(names) = parse_names(&raw, "profiles", &profile_id) {
                return Ok(names);
            }
        }
    }

    Ok(enabled_names(rows))
}

fn profile_names_from_state(
    state: &AppState,
    rows: &[McpRow],
    profile_id: &str,
) -> Result<Vec<String>, CmdError> {
    let raw = state
        .db
        .profile_default_mcp_raw(profile_id)
        .map_err(|e| CmdError::new(50000, format!("读取连接 MCP 名单失败：{e}")))?;
    if let Some(Some(raw)) = raw {
        if let Some(names) = parse_names(&raw, "profiles", profile_id) {
            return Ok(names);
        }
    }
    Ok(enabled_names(rows))
}

fn parse_names(raw: &str, table: &str, id: &str) -> Option<Vec<String>> {
    match serde_json::from_str::<Vec<String>>(raw) {
        Ok(names) => Some(names),
        Err(error) => {
            tracing::warn!(
                target: "sincearc::mcp",
                table = %table,
                id = %id,
                error = %error,
                "MCP 名单 JSON 无法解析，按继承处理"
            );
            None
        }
    }
}

fn enabled_names(rows: &[McpRow]) -> Vec<String> {
    rows.iter()
        .filter(|row| row.3)
        .map(|row| row.0.clone())
        .collect()
}

fn entries_for_names(
    rows: &[McpRow],
    names: &[String],
    scope: &str,
) -> Result<Vec<McpCatalogEntryDto>, CmdError> {
    let wanted: HashSet<&str> = names.iter().map(String::as_str).collect();
    let known: HashSet<&str> = rows.iter().map(|row| row.0.as_str()).collect();
    let mut warned: HashSet<&str> = HashSet::new();
    for name in names {
        if !known.contains(name.as_str()) && warned.insert(name.as_str()) {
            tracing::warn!(
                target: "sincearc::mcp",
                name = %name,
                "MCP 名单里的名字不在目录中，已忽略"
            );
        }
    }

    let mut entries = Vec::new();
    for (name, kind, config_json, enabled, _) in rows {
        if !wanted.contains(name.as_str()) {
            continue;
        }
        match row_to_entry(name.clone(), kind.clone(), config_json, *enabled) {
            Some(entry) => entries.push(entry),
            None => tracing::warn!(
                target: "sincearc::mcp",
                name = %name,
                kind = %kind,
                "MCP 目录条目的配置无法解析，已忽略"
            ),
        }
    }

    if entries.len() > EFFECTIVE_MAX {
        return Err(CmdError::new(
            50700,
            format!("{scope}生效 {} 条，上限 {EFFECTIVE_MAX}", entries.len()),
        ));
    }
    Ok(entries)
}

fn entry_values(entries: Vec<McpCatalogEntryDto>) -> Result<Vec<Value>, CmdError> {
    entries
        .into_iter()
        .map(|entry| {
            serde_json::to_value(entry.server)
                .map_err(|e| CmdError::new(50700, format!("MCP 配置序列化失败：{e}")))
        })
        .collect()
}

fn row_to_entry(
    name: String,
    kind: String,
    config_json: &str,
    enabled: bool,
) -> Option<McpCatalogEntryDto> {
    let config: Value = serde_json::from_str(config_json).ok()?;
    let mut object = config.as_object()?.clone();
    object.insert("name".to_string(), Value::String(name.clone()));
    match kind.as_str() {
        "stdio" => {}
        "http" | "sse" => {
            object.insert("type".to_string(), Value::String(kind.clone()));
        }
        _ => return None,
    }
    let server: McpServerDto = serde_json::from_value(Value::Object(object)).ok()?;
    Some(McpCatalogEntryDto {
        name,
        kind,
        enabled,
        server,
    })
}

fn config_json(server: &McpServerDto) -> Result<String, CmdError> {
    let config = match server {
        McpServerDto::Stdio {
            command, args, env, ..
        } => json!({ "command": command, "args": args, "env": env }),
        McpServerDto::Http { url, headers, .. }
        | McpServerDto::Sse { url, headers, .. } => {
            json!({ "url": url, "headers": headers })
        }
    };
    serde_json::to_string(&config)
        .map_err(|e| CmdError::new(50700, format!("MCP 配置序列化失败：{e}")))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::json;

    use super::*;
    use crate::commands::ProfileDto;
    use crate::db::{Db, SessionUpsert};

    fn temp_state() -> (AppState, PathBuf) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "sincearc-mcp-test-{}-{nanos}.db",
            std::process::id()
        ));
        let db = Db::open(&path).expect("open temp db");
        (AppState::new(db), path)
    }

    fn cleanup(path: &Path) {
        std::fs::remove_file(path).ok();
    }

    fn profile(id: &str) -> ProfileDto {
        ProfileDto {
            id: id.into(),
            name: "p".into(),
            launch: "local".into(),
            program: "agent".into(),
            args: Vec::new(),
            cwd: "/tmp".into(),
            default_mode: None,
            default_mcp: None,
            caps: None,
            caps_at: None,
            distro: None,
            shell: None,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_auth: None,
            ssh_key_path: None,
            ssh_password: None,
        }
    }

    fn session(id: &str, profile_id: &str) -> SessionUpsert {
        let now = crate::db::now();
        SessionUpsert {
            id: id.into(),
            acp_session_id: None,
            mode_override: None,
            profile_id: Some(profile_id.into()),
            title: "test".into(),
            cwd: "/tmp".into(),
            created_at: now,
            updated_at: now,
        }
    }

    fn seed_catalog(state: &AppState) {
        state
            .db
            .upsert_mcp_server("a", "stdio", r#"{"command":"a","args":[],"env":[]}"#, true)
            .unwrap();
        state
            .db
            .upsert_mcp_server("b", "http", r#"{"url":"https://b.example","headers":[]}"#, true)
            .unwrap();
        state
            .db
            .upsert_mcp_server("c", "sse", r#"{"url":"https://c.example","headers":[]}"#, true)
            .unwrap();
        state
            .db
            .upsert_mcp_server("d", "stdio", r#"{"command":"d","args":[],"env":[]}"#, false)
            .unwrap();
    }

    fn seed_profile_and_session(state: &AppState) {
        state.db.save_profiles(&[profile("p1")]).unwrap();
        state.db.upsert_session(&session("s1", "p1")).unwrap();
    }

    fn names_of(values: &[Value]) -> Vec<String> {
        values
            .iter()
            .map(|value| value["name"].as_str().unwrap().to_string())
            .collect()
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn stdio(name: &str, command: &str) -> McpServerDto {
        McpServerDto::Stdio {
            name: name.into(),
            command: command.into(),
            args: Vec::new(),
            env: Vec::new(),
        }
    }

    #[test]
    fn stdio_serializes_without_type() {
        let server = McpServerDto::Stdio {
            name: "fs".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "server-filesystem".into()],
            env: vec![McpKeyValueDto {
                name: "TOKEN".into(),
                value: "secret".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(server).unwrap(),
            json!({
                "name": "fs",
                "command": "npx",
                "args": ["-y", "server-filesystem"],
                "env": [{ "name": "TOKEN", "value": "secret" }],
            })
        );
    }

    #[test]
    fn http_serializes_with_type() {
        let server = McpServerDto::Http {
            name: "remote".into(),
            url: "https://example.test/mcp".into(),
            headers: vec![McpKeyValueDto {
                name: "Authorization".into(),
                value: "Bearer x".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(server).unwrap(),
            json!({
                "type": "http",
                "name": "remote",
                "url": "https://example.test/mcp",
                "headers": [{ "name": "Authorization", "value": "Bearer x" }],
            })
        );
    }

    #[test]
    fn sse_serializes_with_type() {
        let server = McpServerDto::Sse {
            name: "legacy".into(),
            url: "http://example.test/sse".into(),
            headers: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(server).unwrap(),
            json!({
                "type": "sse",
                "name": "legacy",
                "url": "http://example.test/sse",
                "headers": [],
            })
        );
    }

    #[test]
    fn deserializes_by_type_and_defaults_to_stdio() {
        let stdio_value: McpServerDto =
            serde_json::from_value(json!({ "name": "fs", "command": "npx" })).unwrap();
        assert!(matches!(stdio_value, McpServerDto::Stdio { .. }));

        let http_value: McpServerDto = serde_json::from_value(json!({
            "type": "http",
            "name": "remote",
            "url": "https://example.test/mcp",
        }))
        .unwrap();
        assert!(matches!(http_value, McpServerDto::Http { .. }));
    }

    #[test]
    fn validation_rejects_empty_name() {
        let error = validate_mcp_server(&stdio("  ", "npx")).expect_err("empty name");
        assert_eq!(error.code, 50700);
        assert!(error.msg.contains("名称"));
    }

    #[test]
    fn validation_rejects_long_name() {
        let error = validate_mcp_server(&stdio(&"a".repeat(65), "npx")).expect_err("long name");
        assert_eq!(error.code, 50700);
        assert!(error.msg.contains("64"));
    }

    #[test]
    fn duplicate_trimmed_name_overwrites_instead_of_duplicating() {
        let (state, path) = temp_state();
        upsert_server(&state, stdio("fs", "first"), true).unwrap();
        upsert_server(&state, stdio(" fs ", "second"), true).unwrap();
        let rows = state.db.mcp_catalog_rows().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "fs");
        assert!(rows[0].2.contains("second"));
        cleanup(&path);
    }

    #[test]
    fn validation_rejects_empty_command() {
        let error = validate_mcp_server(&stdio("fs", "  ")).expect_err("empty command");
        assert_eq!(error.code, 50700);
        assert!(error.msg.contains("command"));
    }

    #[test]
    fn validation_rejects_url_without_protocol() {
        let server = McpServerDto::Http {
            name: "remote".into(),
            url: "example.test/mcp".into(),
            headers: Vec::new(),
        };
        let error = validate_mcp_server(&server).expect_err("url without protocol");
        assert_eq!(error.code, 50700);
        assert!(error.msg.contains("http://"));
    }

    #[test]
    fn validation_rejects_too_many_env_pairs() {
        let server = McpServerDto::Stdio {
            name: "fs".into(),
            command: "npx".into(),
            args: Vec::new(),
            env: (0..33)
                .map(|index| McpKeyValueDto {
                    name: format!("K{index}"),
                    value: "v".into(),
                })
                .collect(),
        };
        let error = validate_mcp_server(&server).expect_err("33 env pairs");
        assert_eq!(error.code, 50700);
        assert!(error.msg.contains("32"));
    }

    #[test]
    fn validation_rejects_env_value_over_4kb() {
        let server = McpServerDto::Stdio {
            name: "fs".into(),
            command: "npx".into(),
            args: Vec::new(),
            env: vec![McpKeyValueDto {
                name: "TOKEN".into(),
                value: "x".repeat(4097),
            }],
        };
        let error = validate_mcp_server(&server).expect_err("4KB+ value");
        assert_eq!(error.code, 50700);
        assert!(error.msg.contains("4KB"));
    }

    #[test]
    fn catalog_rejects_65th_entry() {
        let (state, path) = temp_state();
        for index in 0..64 {
            upsert_server(&state, stdio(&format!("s{index:02}"), "npx"), true).unwrap();
        }
        let error = upsert_server(&state, stdio("s64", "npx"), true).expect_err("65th entry");
        assert_eq!(error.code, 50700);
        assert!(error.msg.contains("64"));
        cleanup(&path);
    }

    #[tokio::test]
    async fn session_and_profile_null_follow_catalog_enabled() {
        let (state, path) = temp_state();
        seed_catalog(&state);
        seed_profile_and_session(&state);

        let names = session_mcp_names(&state, "s1").await.unwrap();
        assert_eq!(names, strings(&["a", "b", "c"]));
        let servers = session_mcp_servers(&state, "s1").await.unwrap();
        assert_eq!(names_of(&servers), strings(&["a", "b", "c"]));
        cleanup(&path);
    }

    #[tokio::test]
    async fn profile_array_wins_over_catalog_and_output_stays_in_rowid_order() {
        let (state, path) = temp_state();
        seed_catalog(&state);
        seed_profile_and_session(&state);
        state
            .db
            .set_profile_default_mcp("p1", Some(r#"["c","a"]"#))
            .unwrap();

        let names = session_mcp_names(&state, "s1").await.unwrap();
        assert_eq!(names, strings(&["c", "a"]));
        let servers = session_mcp_servers(&state, "s1").await.unwrap();
        assert_eq!(names_of(&servers), strings(&["a", "c"]));
        cleanup(&path);
    }

    #[tokio::test]
    async fn explicit_empty_session_names_beat_profile() {
        let (state, path) = temp_state();
        seed_catalog(&state);
        seed_profile_and_session(&state);
        state
            .db
            .set_profile_default_mcp("p1", Some(r#"["a"]"#))
            .unwrap();
        state
            .db
            .set_session_mcp_names("s1", Some("[]"))
            .unwrap();

        assert!(session_mcp_names(&state, "s1").await.unwrap().is_empty());
        assert!(session_mcp_servers(&state, "s1").await.unwrap().is_empty());
        cleanup(&path);
    }

    #[tokio::test]
    async fn session_array_wins_over_profile() {
        let (state, path) = temp_state();
        seed_catalog(&state);
        seed_profile_and_session(&state);
        state
            .db
            .set_profile_default_mcp("p1", Some(r#"["a"]"#))
            .unwrap();
        state
            .db
            .set_session_mcp_names("s1", Some(r#"["b"]"#))
            .unwrap();

        let servers = session_mcp_servers(&state, "s1").await.unwrap();
        assert_eq!(names_of(&servers), strings(&["b"]));
        cleanup(&path);
    }

    #[tokio::test]
    async fn missing_catalog_name_is_dropped_without_affecting_others() {
        let (state, path) = temp_state();
        seed_catalog(&state);
        seed_profile_and_session(&state);
        state
            .db
            .set_session_mcp_names("s1", Some(r#"["b","ghost"]"#))
            .unwrap();

        let servers = session_mcp_servers(&state, "s1").await.unwrap();
        assert_eq!(names_of(&servers), strings(&["b"]));
        cleanup(&path);
    }

    #[tokio::test]
    async fn bad_session_json_is_treated_as_inherit() {
        let (state, path) = temp_state();
        seed_catalog(&state);
        seed_profile_and_session(&state);
        state
            .db
            .set_session_mcp_names("s1", Some("{oops"))
            .unwrap();

        let names = session_mcp_names(&state, "s1").await.unwrap();
        assert_eq!(names, strings(&["a", "b", "c"]));
        cleanup(&path);
    }

    #[tokio::test]
    async fn bad_profile_json_is_treated_as_inherit() {
        let (state, path) = temp_state();
        seed_catalog(&state);
        seed_profile_and_session(&state);
        state
            .db
            .set_profile_default_mcp("p1", Some("{oops"))
            .unwrap();

        let names = session_mcp_names(&state, "s1").await.unwrap();
        assert_eq!(names, strings(&["a", "b", "c"]));
        cleanup(&path);
    }

    #[tokio::test]
    async fn more_than_32_effective_servers_is_an_error() {
        let (state, path) = temp_state();
        for index in 0..33 {
            state
                .db
                .upsert_mcp_server(
                    &format!("s{index:02}"),
                    "stdio",
                    r#"{"command":"npx","args":[],"env":[]}"#,
                    true,
                )
                .unwrap();
        }
        seed_profile_and_session(&state);

        let error = session_mcp_servers(&state, "s1")
            .await
            .expect_err("33 effective servers");
        assert_eq!(error.code, 50700);
        assert_eq!(error.msg, "本会话生效 33 条，上限 32");
        cleanup(&path);
    }
}
