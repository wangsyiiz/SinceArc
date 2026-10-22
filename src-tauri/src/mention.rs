//! 群聊 `@` 解析（docs/group-chat.md §3）。
//!
//! 不用「`@` 后面接一串字符」的正则：短名可能含中文，字符集规则容易把
//! `@hermes-测试2` 截成 `@hermes-`。这里拿已知短名去原文里找：
//! 命中位置最早者胜；同一位置取更长的短名。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub handle: String,
    /// `@` 在原文里的字节下标
    pub start: usize,
    /// 命中片段结束（不含）
    pub end: usize,
}

/// 后面必须是边界：不能紧跟字母/数字/下划线/连字符，避免 `@a` 命中 `@ab`。
fn is_boundary(c: char) -> bool {
    !(c.is_alphanumeric() || c == '_' || c == '-')
}

fn char_eq_ci(a: char, b: char) -> bool {
    a.to_lowercase().eq(b.to_lowercase())
}

/// 两个短名是否只在大小写上不同。命令层用它确认命中的成员（并发现重复短名）。
pub fn same_handle(a: &str, b: &str) -> bool {
    a.chars()
        .flat_map(char::to_lowercase)
        .eq(b.chars().flat_map(char::to_lowercase))
}

/// 从 `rest` 开头按字符做大小写不敏感匹配，返回命中部分在 `rest` 里的字节长度。
fn match_handle_ci(rest: &str, handle: &str) -> Option<usize> {
    let mut consumed = 0;
    let mut chars = rest.char_indices();
    for want in handle.chars() {
        let (offset, got) = chars.next()?;
        if !char_eq_ci(got, want) {
            return None;
        }
        consumed = offset + got.len_utf8();
    }
    Some(consumed)
}

/// 拿已知短名去文本里找：命中位置最早者胜；同位置取更长者。
pub fn find(text: &str, handles: &[String]) -> Option<Hit> {
    let mut best: Option<Hit> = None;

    for handle in handles {
        if handle.is_empty() {
            continue;
        }
        for (at, _) in text.match_indices('@') {
            let before_ok = at == 0
                || text[..at]
                    .chars()
                    .next_back()
                    .is_some_and(char::is_whitespace);
            if !before_ok {
                continue;
            }

            let after_at = at + 1;
            let Some(consumed) = match_handle_ci(&text[after_at..], handle) else {
                continue;
            };
            let end = after_at + consumed;
            let after_ok = text[end..].chars().next().map_or(true, is_boundary);
            if !after_ok {
                continue;
            }

            let better = match &best {
                None => true,
                Some(prev) => {
                    at < prev.start || (at == prev.start && handle.len() > prev.handle.len())
                }
            };
            if better {
                best = Some(Hit {
                    handle: handle.clone(),
                    start: at,
                    end,
                });
            }
            // 同一个短名的第一个有效出现就是最早的，后面的不必再看。
            break;
        }
    }

    best
}

fn is_token_punct(c: char) -> bool {
    matches!(
        c,
        '，' | '。' | '、' | ',' | '.' | '!' | '?' | '！' | '？' | ':' | '：' | ';' | '；'
    )
}

/// 用户敲了 `@` 但没对上任何成员时，取出他到底敲了什么（在第一个句读标点处截断）。
pub fn token(text: &str) -> Option<String> {
    for (at, c) in text.char_indices() {
        if c != '@' {
            continue;
        }
        let before_ok = at == 0
            || text[..at]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if !before_ok {
            continue;
        }

        let rest = &text[at + 1..];
        let word_end = rest
            .char_indices()
            .find(|(_, ch)| ch.is_whitespace())
            .map_or(rest.len(), |(i, _)| i);
        let raw = &rest[..word_end];
        // `@` 后面先是空白：正则 `\S+` 不成立，继续找后面的 `@`。
        if raw.is_empty() {
            continue;
        }

        let cut = raw
            .char_indices()
            .find(|(_, ch)| is_token_punct(*ch))
            .map_or(raw.len(), |(i, _)| i);
        let candidate = &raw[..cut];
        return if candidate.is_empty() {
            None
        } else {
            Some(candidate.to_string())
        };
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handles(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn finds_chinese_handle_at_start() {
        let hit = find("@hermes-测试2 看看", &handles(&["hermes-测试2"])).expect("hit");
        assert_eq!(hit.handle, "hermes-测试2");
        assert_eq!(hit.start, 0);
        assert_eq!(hit.end, 1 + "hermes-测试2".len());
    }

    #[test]
    fn token_stops_at_first_punctuation() {
        assert_eq!(token("@hermes-9，行吗").as_deref(), Some("hermes-9"));
        assert_eq!(token("看看 @hermes-9，行吗").as_deref(), Some("hermes-9"));
    }

    #[test]
    fn longer_handle_wins_at_same_start() {
        let hit = find(
            "@hermes-测试2 看一下",
            &handles(&["hermes-测试", "hermes-测试2"]),
        )
        .expect("hit");
        assert_eq!(hit.handle, "hermes-测试2");
    }

    #[test]
    fn prefix_is_not_a_match() {
        assert!(find("@ab", &handles(&["a"])).is_none());
        assert!(find("@backend3 你好", &handles(&["backend", "backend2"])).is_none());
    }

    #[test]
    fn requires_left_boundary() {
        assert!(find("foo@a", &handles(&["a"])).is_none());
        assert!(find("a@backend 你好", &handles(&["backend"])).is_none());
    }

    #[test]
    fn case_insensitive_match() {
        let hit = find("@HERMES 你好", &handles(&["hermes"])).expect("hit");
        assert_eq!(hit.handle, "hermes");
    }

    #[test]
    fn token_none_without_at() {
        assert!(token("没有提及").is_none());
        assert!(token("john@example.com").is_none());
    }

    #[test]
    fn single_chinese_handle_matches() {
        let hit = find("麻烦 @甲 看一下", &handles(&["甲"])).expect("hit");
        assert_eq!(hit.handle, "甲");
    }

    #[test]
    fn unknown_handle_does_not_match() {
        assert!(find("@claude 你好", &handles(&["hermes", "backend"])).is_none());
    }
}
