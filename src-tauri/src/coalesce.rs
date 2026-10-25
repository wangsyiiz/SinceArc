//! 正文合批（`docs/ipc-contract.md` §4）。
//!
//! agent 的 `agent_message_chunk` 是逐段来的（实测一次回答几十到几百条）。一条一个 IPC 事件、
//! 一次 React 更新，代价全落在 webview 上。以前是前端自己攒 40ms —— 等于让 UI 线程做流控。
//! 现在在 Rust 侧按 30ms / 4KB 合并：前端拿到多少就渲染多少，不再自己攒。
//!
//! 只做「攒与冲」，不认识会话语义：key 变了就先把上一段冲掉，保证文字顺序不会跑到
//! 工具调用/权限请求之后。

/// 达到这个字节数就立刻发一段：长回答的开头不该等满 30ms。
pub const FLUSH_BYTES: usize = 4 * 1024;

/// 一段待发的正文（已合并）。
#[derive(Debug, Clone, PartialEq)]
pub struct Flush {
    pub session_id: Option<String>,
    pub ui_session_id: Option<String>,
    pub author_id: Option<String>,
    pub message_id: Option<String>,
    pub text: String,
}

/// 合批的「同一段」判据：会话 / 界面会话 / 作者 / 消息 id 任一变化都必须先冲掉上一段。
type CoalesceKey = (Option<String>, Option<String>, Option<String>, Option<String>);

#[derive(Debug, Default)]
pub struct TextCoalescer {
    key: Option<CoalesceKey>,
    text: String,
}

impl TextCoalescer {
    pub fn pending(&self) -> usize {
        self.text.len()
    }

    /// 收一段正文。返回 `Some` 表示「这一段该发了」（key 变了或够大）。
    ///
    /// 顺序保证：调用方在收非正文事件前必须先 `flush`，否则会出现
    /// 「工具调用已经显示，文字却还在缓冲区」的错位。
    pub fn push(
        &mut self,
        session_id: Option<String>,
        ui_session_id: Option<String>,
        author_id: Option<String>,
        message_id: Option<String>,
        chunk: &str,
    ) -> Option<Flush> {
        let key = (session_id, ui_session_id, author_id, message_id);
        let mut flushed = None;

        if self.key.as_ref() != Some(&key) {
            flushed = self.take();
            self.key = Some(key);
        }
        self.text.push_str(chunk);

        if self.text.len() >= FLUSH_BYTES {
            // 已经有待发的一段时，把刚收的这段也并进去一起发（不让两段乱序）
            let more = self.take();
            flushed = match (flushed, more) {
                (Some(mut a), Some(b)) => {
                    a.text.push_str(&b.text);
                    Some(a)
                }
                (a, b) => a.or(b),
            };
        }
        flushed
    }

    pub fn flush(&mut self) -> Option<Flush> {
        self.take()
    }

    fn take(&mut self) -> Option<Flush> {
        if self.text.is_empty() {
            return None;
        }
        let (session_id, ui_session_id, author_id, message_id) =
            self.key.clone().unwrap_or((None, None, None, None));
        Some(Flush {
            session_id,
            ui_session_id,
            author_id,
            message_id,
            text: std::mem::take(&mut self.text),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid() -> (Option<String>, Option<String>, Option<String>) {
        (
            Some("acp-1".into()),
            Some("ui-1".into()),
            None,
        )
    }

    #[test]
    fn 不足阈值时先攒着() {
        let mut c = TextCoalescer::default();
        let (s, u, a) = sid();
        assert!(c.push(s, u, a, None, "你好").is_none());
        assert_eq!(c.pending(), 6);
    }

    #[test]
    fn 达到四_kb_立刻发() {
        let mut c = TextCoalescer::default();
        let (s, u, a) = sid();
        let big = "字".repeat(1400); // 4200 字节
        let out = c.push(s, u, a, None, &big).expect("够 4KB 要立刻发");
        assert_eq!(out.text.len(), big.len());
        assert_eq!(c.pending(), 0, "发完要清空");
    }

    #[test]
    fn 换会话时先把上一段冲掉_顺序不串() {
        let mut c = TextCoalescer::default();
        let (s, u, a) = sid();
        c.push(s.clone(), u.clone(), a.clone(), None, "第一段");
        let out = c
            .push(Some("acp-2".into()), u, a, None, "第二段")
            .expect("换 key 必须先冲上一段");
        assert_eq!(out.session_id.as_deref(), Some("acp-1"));
        assert_eq!(out.text, "第一段");
        assert_eq!(c.pending(), "第二段".len());
    }

    #[test]
    fn 空缓冲不发空事件() {
        let mut c = TextCoalescer::default();
        assert!(c.flush().is_none());
    }

    #[test]
    fn message_id_变化时先冲上一段() {
        let mut c = TextCoalescer::default();
        let (s, u, a) = sid();
        c.push(s.clone(), u.clone(), a.clone(), Some("m1".into()), "第一段");
        let out = c
            .push(s, u, a, Some("m2".into()), "第二段")
            .expect("换 messageId 必须先冲上一段");
        assert_eq!(out.message_id.as_deref(), Some("m1"));
        assert_eq!(out.text, "第一段");
    }
}
