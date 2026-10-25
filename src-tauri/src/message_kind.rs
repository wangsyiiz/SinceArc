//! 消息 kind 的代码内注册表。新增消息形态只加一条注册项，不再散落组件分支。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum MergeRule {
    #[serde(rename = "stream")]
    Stream,
    #[serde(rename = "tool")]
    Tool,
    #[serde(rename = "request")]
    Request,
    #[serde(rename = "none")]
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/lib/ipc/types.gen/")]
pub enum MessageKind {
    #[serde(rename = "text.user")]
    TextUser,
    #[serde(rename = "text.agent")]
    TextAgent,
    #[serde(rename = "aside")]
    Aside,
    #[serde(rename = "delegate.card")]
    DelegateCard,
    #[serde(rename = "notice.system")]
    NoticeSystem,
    #[serde(rename = "thought")]
    Thought,
    #[serde(rename = "tool_call")]
    ToolCall,
    #[serde(rename = "tool_call_update")]
    ToolCallUpdate,
    #[serde(rename = "permission")]
    Permission,
    #[serde(rename = "permission_decision")]
    PermissionDecision,
    #[serde(rename = "usage")]
    Usage,
    #[serde(rename = "commands")]
    Commands,
    #[serde(rename = "delegate.request")]
    DelegateRequest,
    #[serde(rename = "delegate.result")]
    DelegateResult,
}

impl MessageKind {
    pub const ALL: [Self; 14] = [
        Self::TextUser,
        Self::TextAgent,
        Self::Aside,
        Self::DelegateCard,
        Self::NoticeSystem,
        Self::Thought,
        Self::ToolCall,
        Self::ToolCallUpdate,
        Self::Permission,
        Self::PermissionDecision,
        Self::Usage,
        Self::Commands,
        Self::DelegateRequest,
        Self::DelegateResult,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::TextUser => "text.user",
            Self::TextAgent => "text.agent",
            Self::Aside => "aside",
            Self::DelegateCard => "delegate.card",
            Self::NoticeSystem => "notice.system",
            Self::Thought => "thought",
            Self::ToolCall => "tool_call",
            Self::ToolCallUpdate => "tool_call_update",
            Self::Permission => "permission",
            Self::PermissionDecision => "permission_decision",
            Self::Usage => "usage",
            Self::Commands => "commands",
            Self::DelegateRequest => "delegate.request",
            Self::DelegateResult => "delegate.result",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct KindSpec {
    pub kind: MessageKind,
    pub chat: bool,
    pub merge: MergeRule,
    pub payload_schema: &'static str,
    pub renderer: Option<&'static str>,
    pub owner: &'static str,
}

const REGISTRY: &[KindSpec] = &[
    KindSpec {
        kind: MessageKind::TextUser,
        chat: true,
        merge: MergeRule::None,
        payload_schema: "text/1",
        renderer: Some("message.text.user"),
        owner: "chat",
    },
    KindSpec {
        kind: MessageKind::TextAgent,
        chat: true,
        merge: MergeRule::Stream,
        payload_schema: "text/1",
        renderer: Some("message.text.agent"),
        owner: "chat",
    },
    KindSpec {
        kind: MessageKind::Aside,
        chat: true,
        merge: MergeRule::None,
        payload_schema: "aside/1",
        renderer: Some("message.aside"),
        owner: "chat",
    },
    KindSpec {
        kind: MessageKind::DelegateCard,
        chat: true,
        merge: MergeRule::None,
        payload_schema: "delegate.card/1",
        renderer: Some("message.delegate.card"),
        owner: "delegate",
    },
    KindSpec {
        kind: MessageKind::NoticeSystem,
        chat: true,
        merge: MergeRule::None,
        payload_schema: "notice.system/1",
        renderer: Some("message.notice.system"),
        owner: "chat",
    },
    KindSpec {
        kind: MessageKind::Thought,
        chat: false,
        merge: MergeRule::Stream,
        payload_schema: "thought/1",
        renderer: None,
        owner: "trace",
    },
    KindSpec {
        kind: MessageKind::ToolCall,
        chat: false,
        merge: MergeRule::Tool,
        payload_schema: "tool_call/1",
        renderer: None,
        owner: "tools",
    },
    KindSpec {
        kind: MessageKind::ToolCallUpdate,
        chat: false,
        merge: MergeRule::Tool,
        payload_schema: "tool_call_update/1",
        renderer: None,
        owner: "tools",
    },
    KindSpec {
        kind: MessageKind::Permission,
        chat: false,
        merge: MergeRule::Request,
        payload_schema: "permission/1",
        renderer: None,
        owner: "permissions",
    },
    KindSpec {
        kind: MessageKind::PermissionDecision,
        chat: false,
        merge: MergeRule::Request,
        payload_schema: "permission_decision/1",
        renderer: None,
        owner: "permissions",
    },
    KindSpec {
        kind: MessageKind::Usage,
        chat: false,
        merge: MergeRule::None,
        payload_schema: "usage/1",
        renderer: None,
        owner: "usage",
    },
    KindSpec {
        kind: MessageKind::Commands,
        chat: false,
        merge: MergeRule::None,
        payload_schema: "commands/1",
        renderer: None,
        owner: "commands",
    },
    KindSpec {
        kind: MessageKind::DelegateRequest,
        chat: false,
        merge: MergeRule::None,
        payload_schema: "delegate.request/1",
        renderer: None,
        owner: "delegate",
    },
    KindSpec {
        kind: MessageKind::DelegateResult,
        chat: false,
        merge: MergeRule::None,
        payload_schema: "delegate.result/1",
        renderer: None,
        owner: "delegate",
    },
];

pub fn registry() -> &'static [KindSpec] {
    REGISTRY
}

pub fn spec(kind: &str) -> Option<&'static KindSpec> {
    REGISTRY.iter().find(|entry| entry.kind.as_str() == kind)
}

pub fn is_chat_kind(kind: &str) -> bool {
    spec(kind).is_some_and(|entry| entry.chat)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_all_fourteen_kinds() {
        assert_eq!(registry().len(), MessageKind::ALL.len());
        for kind in MessageKind::ALL {
            let entry = spec(kind.as_str()).expect("each MessageKind must be registered");
            assert_eq!(entry.kind, kind);
        }
    }

    #[test]
    fn chat_kinds_have_renderers() {
        for entry in registry().iter().filter(|entry| entry.chat) {
            assert!(
                entry.renderer.is_some(),
                "{:?} is chat kind without renderer",
                entry.kind
            );
        }
    }

    #[test]
    fn unregistered_kinds_are_not_chat() {
        assert!(is_chat_kind("text.agent"));
        assert!(!is_chat_kind("thought"));
        assert!(!is_chat_kind("未来新类型"));
    }
}
