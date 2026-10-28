//! 仓库身份解析：从本地工作树读出 origin，得到 `[HOST/]OWNER/REPO`（docs/gh.md §2.1）。
//!
//! 只用 `std::fs`：不调 `git` 进程、不碰网络、不读 `~/.config/gh/hosts.yml`。
//! 解析规则是纯函数，方便按表驱动单测；路径侧单测用临时目录自建。

use std::path::{Path, PathBuf};

use super::model::{GhError, RepoRef};

/// URL 为什么没解析出来。只用于内部判断与日志，界面文案由 `NoRemote` 的 key 承担。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ParseUrlError {
    /// 空串。
    Empty,
    /// 不认识的形状（`git://`、`file://`、本地路径、没有分隔符的字符串…）。
    Unsupported,
    /// 有 host 但路径不足两段。
    TooFewSegments,
    /// 取到了 host 但它是空的（例如 `https:///o/r`）。
    EmptyHost,
}

/// 把远端 URL 解析成 `(host, owner, name)`。
///
/// 支持 `https://` / `http://` / `ssh://` / scp 风格 `[user@]host:path`；
/// 其余 scheme 与本地路径一律拒绝（§2.1 的兜底）。段数 > 2 时取最后两段并留日志。
pub(crate) fn parse_remote_url(url: &str) -> Result<(String, String, String), ParseUrlError> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err(ParseUrlError::Empty);
    }
    // `/home/x/repo`、`\\server\share` —— 本地路径，不是远端。
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(ParseUrlError::Unsupported);
    }
    // `C:\src\repo`、`C:/src/repo`：看起来像 scp 风格，其实是盘符路径。
    if is_windows_drive_path(raw) {
        return Err(ParseUrlError::Unsupported);
    }

    if let Some((scheme, rest)) = raw.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "https" | "http" | "ssh") {
            return Err(ParseUrlError::Unsupported);
        }
        let (authority, path) = match rest.find('/') {
            Some(index) => (&rest[..index], &rest[index + 1..]),
            None => (rest, ""),
        };
        let host = host_of(authority)?;
        return build(host, split_segments(path));
    }

    // scp 风格：`git@github.com:owner/repo.git`。冒号前不能含路径分隔符，
    // 否则 `origin`、`/x/y` 这类字符串会被误判成远端。
    let Some((authority, path)) = raw.split_once(':') else {
        return Err(ParseUrlError::Unsupported);
    };
    if authority.contains('/') || authority.contains('\\') {
        return Err(ParseUrlError::Unsupported);
    }
    let host = host_of(authority)?;
    build(host, split_segments(path.trim_start_matches('/')))
}

fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// `[user[:password]@]host[:port]` → `host`。
fn host_of(authority: &str) -> Result<String, ParseUrlError> {
    let after_user = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match after_user.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        _ => after_user,
    }
    .trim();
    if host.is_empty() {
        return Err(ParseUrlError::EmptyHost);
    }
    Ok(host.to_string())
}

fn split_segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|segment| !segment.is_empty()).collect()
}

fn build(host: String, segments: Vec<&str>) -> Result<(String, String, String), ParseUrlError> {
    if segments.len() < 2 {
        return Err(ParseUrlError::TooFewSegments);
    }
    if segments.len() > 2 {
        tracing::warn!(
            target: "sincearc::gh",
            host = %host,
            segments = segments.len(),
            "remote url has nested path; using the last two segments"
        );
    }
    let owner = segments[segments.len() - 2];
    let name = segments[segments.len() - 1]
        .strip_suffix(".git")
        .unwrap_or(segments[segments.len() - 1]);
    if owner.is_empty() || name.is_empty() {
        return Err(ParseUrlError::TooFewSegments);
    }
    Ok((host, owner.to_string(), name.to_string()))
}

/// 从本地路径解析仓库身份。判定顺序见 docs/gh.md §2.1。
pub fn resolve_repo(path: &str) -> Result<RepoRef, GhError> {
    let input = path.trim();
    let not_repo = || GhError::NotGitRepo {
        path: input.to_string(),
    };
    if input.is_empty() {
        return Err(not_repo());
    }

    // 路径不存在时不要退化成「从父目录往上找」：相对路径的 parent 可能是 ""，
    // 那样会把当前工作目录当成输入路径，误认成 cwd 所在的仓库。
    if !Path::new(input).exists() {
        return Err(not_repo());
    }
    // 先绝对化：相对路径（如 `src`）逐级 parent() 会经过空串，等于从进程 cwd 重新开始找。
    // `canonicalize` 属于 std::fs，不额外起进程；上面已确认路径存在，失败时才退回原值。
    let start = std::fs::canonicalize(input).unwrap_or_else(|_| PathBuf::from(input));
    let Some((workdir, dot_git)) = find_dot_git(&start) else {
        return Err(not_repo());
    };
    let gitdir = match resolve_gitdir(&workdir, &dot_git) {
        Some(dir) => dir,
        None => return Err(not_repo()),
    };
    // 读不到 config 与「config 里没有 remote」是同一件事：没有可用的远端。
    // 不把它算成「不是 git 仓库」—— `.git` 明明在，那样会误导用户去重新选目录。
    let config = std::fs::read_to_string(gitdir.join("config")).unwrap_or_else(|error| {
        tracing::warn!(
            target: "sincearc::gh",
            gitdir = %gitdir.display(),
            error = %error,
            "git config is unreadable"
        );
        String::new()
    });

    let remotes = parse_remotes(&config);
    let url = match remotes.iter().find(|remote| remote.name == "origin") {
        Some(origin) => origin.url.clone(),
        // 没有 origin：恰好一个 remote 才用它的 url，0 个或多个都拒绝（不猜）。
        None if remotes.len() == 1 => remotes[0].url.clone(),
        None => None,
    };
    let Some(url) = url else {
        return Err(GhError::NoRemote {
            path: input.to_string(),
            detail: "没有 remote".to_string(),
        });
    };

    let (host, owner, name) = parse_remote_url(&url).map_err(|error| {
        tracing::warn!(
            target: "sincearc::gh",
            url = %url,
            error = ?error,
            "git remote url could not be recognised"
        );
        GhError::NoRemote {
            path: input.to_string(),
            detail: url.clone(),
        }
    })?;

    Ok(RepoRef {
        host: Some(host),
        owner,
        name,
    })
}

/// 从 `start` 向上找 `.git`，返回（包含 `.git` 的目录，`.git` 本身）。
fn find_dot_git(start: &Path) -> Option<(PathBuf, PathBuf)> {
    let mut dir = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        let candidate = dir.join(".git");
        if candidate.exists() {
            return Some((dir, candidate));
        }
        let parent = dir.parent()?.to_path_buf();
        if parent == dir {
            return None;
        }
        dir = parent;
    }
}

/// `.git` 可能是目录（普通仓库），也可能是文件（worktree / submodule）。
/// 文件里的 `gitdir:` 相对路径以 `.git` 所在目录为基准。
fn resolve_gitdir(workdir: &Path, dot_git: &Path) -> Option<PathBuf> {
    if dot_git.is_dir() {
        return Some(dot_git.to_path_buf());
    }
    let content = std::fs::read_to_string(dot_git).ok()?;
    let target = content.lines().find_map(|line| {
        let rest = line.trim().strip_prefix("gitdir:")?;
        let rest = rest.trim();
        (!rest.is_empty()).then_some(rest)
    })?;
    let target = PathBuf::from(target);
    let resolved = if target.is_absolute() {
        target
    } else {
        workdir.join(target)
    };
    // 指向不存在的 gitdir 说明这是一个坏掉的 worktree 文件，不是「没有远端」。
    resolved.exists().then_some(resolved)
}

#[derive(Debug)]
struct RemoteEntry {
    name: String,
    url: Option<String>,
}

/// 只解析 git config 里 `[remote "name"]` 段与它的 `url`。
///
/// 不追求完整 INI 支持：git 的 section 头与 `key = value` 已够用，
/// 引号、行内空白和注释按最小规则处理。
fn parse_remotes(config: &str) -> Vec<RemoteEntry> {
    let mut remotes: Vec<RemoteEntry> = Vec::new();
    let mut current: Option<usize> = None;

    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if line.starts_with('[') {
            current = parse_remote_section(line).map(|name| {
                remotes.push(RemoteEntry { name, url: None });
                remotes.len() - 1
            });
            continue;
        }
        let Some(index) = current else { continue };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != "url" || remotes[index].url.is_some() {
            continue;
        }
        remotes[index].url = Some(unquote(value.trim()));
    }

    remotes
}

fn parse_remote_section(line: &str) -> Option<String> {
    let inner = line.strip_prefix('[')?.strip_suffix(']')?.trim();
    let rest = inner.strip_prefix("remote")?.trim();
    let name = rest
        .strip_prefix('"')?
        .strip_suffix('"')
        .or_else(|| rest.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')))?;
    (!name.is_empty()).then(|| name.to_string())
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    let unquoted = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|inner| inner.strip_suffix('\'')));
    unquoted.unwrap_or(value).to_string()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "sincearc-gh-repo-test-{}-{}-{}",
                std::process::id(),
                name,
                id
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parse_remote_url_table() {
        // (输入, 期望结果)；Err 只断言拒绝，不锁具体变体。
        type Case<'a> = (&'a str, Option<(&'a str, &'a str, &'a str)>);
        let cases: &[Case] = &[
            ("https://github.com/wangsyiiz/SinceArc.git", Some(("github.com", "wangsyiiz", "SinceArc"))),
            ("https://github.com/wangsyiiz/SinceArc", Some(("github.com", "wangsyiiz", "SinceArc"))),
            ("http://host:8080/o/r", Some(("host", "o", "r"))),
            ("ssh://git@github.com/o/r.git", Some(("github.com", "o", "r"))),
            ("ssh://git@host:2222/o/r", Some(("host", "o", "r"))),
            ("git@github.com:wangsyiiz/SinceArc.git", Some(("github.com", "wangsyiiz", "SinceArc"))),
            ("git@github.com:o/r", Some(("github.com", "o", "r"))),
            ("git://github.com/o/r", None),
            ("file:///C:/x/y", None),
            ("C:\\src\\repo", None),
            ("/home/x/repo", None),
            ("origin", None),
            ("https://host/only-one-seg", None),
            // 嵌套组（GitLab 之类）：取最后两段。
            ("git@host:a/b/c.git", Some(("host", "b", "c"))),
        ];

        for (input, expected) in cases {
            let result = parse_remote_url(input);
            match expected {
                Some((host, owner, name)) => {
                    let parsed = result.unwrap_or_else(|error| panic!("{input} 应该解析成功，实际 {error:?}"));
                    assert_eq!(parsed.0, *host, "host: {input}");
                    assert_eq!(parsed.1, *owner, "owner: {input}");
                    assert_eq!(parsed.2, *name, "name: {input}");
                }
                None => assert!(result.is_err(), "{input} 应该被拒绝，实际 {result:?}"),
            }
        }
    }

    #[test]
    fn parse_remote_url_rejects_empty() {
        assert_eq!(parse_remote_url("   "), Err(ParseUrlError::Empty));
    }

    fn write_repo(dir: &Path, config: &str) {
        let git = dir.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("config"), config).unwrap();
    }

    fn origin_config(url: &str) -> String {
        format!("[core]\n\tbare = false\n[remote \"origin\"]\n\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n")
    }

    fn assert_resolved(result: &Result<RepoRef, GhError>, owner: &str, name: &str) {
        let repo = result.as_ref().unwrap_or_else(|error| panic!("应该解析成功，实际 {error:?}"));
        assert_eq!(repo.host.as_deref(), Some("github.com"));
        assert_eq!(repo.owner, owner);
        assert_eq!(repo.name, name);
    }

    #[test]
    fn resolve_with_git_directory() {
        let temp = TestDir::new("git-dir");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write_repo(&repo, &origin_config("git@github.com:wangsyiiz/SinceArc.git"));

        assert_resolved(&resolve_repo(repo.to_str().unwrap()), "wangsyiiz", "SinceArc");
    }

    #[test]
    fn resolve_from_nested_subdirectory() {
        let temp = TestDir::new("nested");
        let repo = temp.path().join("repo");
        let nested = repo.join("src").join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        write_repo(&repo, &origin_config("https://github.com/o/r.git"));

        assert_resolved(&resolve_repo(nested.to_str().unwrap()), "o", "r");
    }

    #[test]
    fn resolve_worktree_with_relative_gitdir_file() {
        let temp = TestDir::new("worktree");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".git"), "gitdir: ../.gits/worktrees/x\n").unwrap();

        let gitdir = temp.path().join(".gits").join("worktrees").join("x");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::write(gitdir.join("config"), origin_config("git@github.com:o/work-tree.git")).unwrap();

        let resolved = resolve_repo(repo.to_str().unwrap()).unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(resolved.host.as_deref(), Some("github.com"));
        assert_eq!(resolved.owner, "o");
        assert_eq!(resolved.name, "work-tree");
    }

    #[test]
    fn resolve_without_dot_git_is_not_git_repo() {
        let temp = TestDir::new("not-git");
        let plain = temp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();

        let error = resolve_repo(plain.to_str().unwrap()).unwrap_err();
        assert!(matches!(&error, GhError::NotGitRepo { .. }), "实际 {error:?}");
        assert_eq!(error.code(), 50717);

        // 不存在的路径同样是「不是仓库」，且不能借父目录的 .git 蒙混过去。
        let missing = plain.join("missing");
        assert!(matches!(
            resolve_repo(missing.to_str().unwrap()),
            Err(GhError::NotGitRepo { .. })
        ));
    }

    #[test]
    fn resolve_without_remote_is_no_remote() {
        let temp = TestDir::new("no-remote");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write_repo(&repo, "[core]\n\tbare = false\n");

        let error = resolve_repo(repo.to_str().unwrap()).unwrap_err();
        match error {
            GhError::NoRemote { detail, .. } => assert_eq!(detail, "没有 remote"),
            other => panic!("expected NoRemote, got {other:?}"),
        }
        assert_eq!(resolve_repo(repo.to_str().unwrap()).unwrap_err().code(), 50717);
    }

    #[test]
    fn resolve_falls_back_to_single_non_origin_remote() {
        let temp = TestDir::new("single-remote");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write_repo(
            &repo,
            "[remote \"upstream\"]\n\turl = https://github.com/o/upstream.git\n",
        );

        assert_resolved(&resolve_repo(repo.to_str().unwrap()), "o", "upstream");
    }

    #[test]
    fn resolve_rejects_multiple_remotes_without_origin() {
        let temp = TestDir::new("multi-remote");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write_repo(
            &repo,
            "[remote \"a\"]\n\turl = https://github.com/o/a.git\n[remote \"b\"]\n\turl = https://github.com/o/b.git\n",
        );

        let error = resolve_repo(repo.to_str().unwrap()).unwrap_err();
        assert!(matches!(&error, GhError::NoRemote { .. }), "实际 {error:?}");
    }

    #[test]
    fn resolve_rejects_local_origin_path() {
        let temp = TestDir::new("local-origin");
        let repo = temp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        write_repo(&repo, &origin_config("/home/x/repo"));

        let error = resolve_repo(repo.to_str().unwrap()).unwrap_err();
        match error {
            GhError::NoRemote { detail, .. } => assert_eq!(detail, "/home/x/repo"),
            other => panic!("expected NoRemote, got {other:?}"),
        }
    }
}
