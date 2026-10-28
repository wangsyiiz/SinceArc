//! gh adapter：唯一与进程、argv、超时和原始输出打交道的地方。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::model::{
    CheckState, GhCli, GhError, GhStatus, PrState, PrStateView, PullRequest, RepoRef,
};
use serde::Deserialize;

const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const LIST_LIMIT: &str = "30";
const LIST_JSON_FIELDS: &str = "number,title,state,isDraft,mergeable,reviewDecision,author,updatedAt,headRefName,baseRefName,url,statusCheckRollup";

pub struct RealGh {
    roots: Vec<PathBuf>,
    exe: OsString,
}

impl RealGh {
    pub fn new() -> Self {
        Self::with_roots_and_exe(production_roots(), default_exe_name())
    }

    pub fn with_roots(roots: Vec<PathBuf>) -> Self {
        Self::with_roots_and_exe(roots, default_exe_name())
    }

    pub fn with_roots_and_exe(roots: Vec<PathBuf>, exe: impl Into<OsString>) -> Self {
        Self {
            roots,
            exe: exe.into(),
        }
    }

    fn find(&self) -> Option<PathBuf> {
        self.roots
            .iter()
            .map(|root| root.join(&self.exe))
            .find(|candidate| candidate.is_file())
    }

    async fn run(&self, path: &Path, args: &[&str], limit: Duration) -> Result<RunOutput, GhError> {
        let mut command = Command::new(path);
        command
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = command.spawn().map_err(|e| GhError::CliFailed {
            stderr: e.to_string(),
        })?;
        let mut stdout = child.stdout.take().ok_or_else(|| GhError::CliFailed {
            stderr: "stdout pipe unavailable".to_string(),
        })?;
        let mut stderr = child.stderr.take().ok_or_else(|| GhError::CliFailed {
            stderr: "stderr pipe unavailable".to_string(),
        })?;

        let stdout_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            stdout.read_to_end(&mut buf).await.map(|_| buf)
        });
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            stderr.read_to_end(&mut buf).await.map(|_| buf)
        });

        let status = match tokio::time::timeout(limit, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(e)) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err(GhError::CliFailed {
                    stderr: e.to_string(),
                });
            }
            Err(_) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    timeout_secs = limit.as_secs(),
                    "gh command timed out"
                );
                let _ = child.kill().await;
                let _ = child.wait().await;
                stdout_task.abort();
                stderr_task.abort();
                return Err(GhError::Timeout);
            }
        };

        let stdout = read_task(stdout_task).await?;
        let stderr = read_task(stderr_task).await?;
        Ok(RunOutput {
            status,
            stdout,
            stderr,
        })
    }
}

impl Default for RealGh {
    fn default() -> Self {
        Self::new()
    }
}

struct RunOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
}

async fn read_task(
    task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<String, GhError> {
    let bytes = task
        .await
        .map_err(|e| GhError::CliFailed {
            stderr: e.to_string(),
        })?
        .map_err(|e| GhError::CliFailed {
            stderr: e.to_string(),
        })?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn parse_version(stdout: &str) -> Option<String> {
    let first = stdout.lines().next()?.trim().trim_start_matches('\u{feff}');
    let rest = first.strip_prefix("gh version ")?;
    let version = rest.split_whitespace().next()?;
    let core = version.split(|c: char| c == '-' || c == '+').next()?;
    let parts: Vec<&str> = core.split('.').collect();
    let numeric = parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    if parts.len() == 3 && numeric {
        Some(version.to_string())
    } else {
        None
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPr {
    number: u32,
    title: String,
    state: String,
    is_draft: bool,
    mergeable: Option<String>,
    review_decision: Option<String>,
    author: RawAuthor,
    updated_at: String,
    head_ref_name: String,
    base_ref_name: String,
    url: String,
    #[serde(default)]
    status_check_rollup: Option<Vec<RawCheck>>,
}

#[derive(Debug, Deserialize)]
struct RawAuthor {
    login: String,
    name: Option<String>,
    is_bot: bool,
}

#[derive(Debug, Deserialize)]
struct RawCheck {
    #[serde(rename = "__typename")]
    typename: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    state: Option<String>,
}

impl RawPr {
    fn into_model(self) -> PullRequest {
        let review_decision = self
            .review_decision
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mergeable = normalize_mergeable(self.mergeable.as_deref());
        let state = match self.state.to_ascii_uppercase().as_str() {
            "MERGED" => PrStateView::Merged,
            "CLOSED" => PrStateView::Closed,
            "OPEN" if self.is_draft => PrStateView::Draft,
            _ => PrStateView::Open,
        };
        let checks = summarize_checks(self.status_check_rollup.as_deref().unwrap_or(&[]));

        PullRequest {
            number: self.number,
            title: self.title,
            url: self.url,
            state,
            author: super::model::Author {
                login: self.author.login,
                name: self
                    .author
                    .name
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                is_bot: self.author.is_bot,
            },
            head: self.head_ref_name,
            base: self.base_ref_name,
            updated_at: self.updated_at,
            mergeable,
            review_decision,
            checks,
        }
    }
}

fn normalize_mergeable(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("UNKNOWN") {
        None
    } else {
        Some(value.to_ascii_lowercase())
    }
}

fn summarize_checks(checks: &[RawCheck]) -> CheckState {
    if checks.is_empty() {
        return CheckState::Pending;
    }

    let mut pending = false;
    for check in checks {
        let is_status_context = check
            .typename
            .as_deref()
            .map(|kind| kind.eq_ignore_ascii_case("StatusContext"))
            .unwrap_or(false)
            || (check.status.is_none() && check.conclusion.is_none() && check.state.is_some());

        if is_status_context {
            match check
                .state
                .as_deref()
                .map(str::to_ascii_uppercase)
                .as_deref()
            {
                Some("FAILURE") | Some("ERROR") => return CheckState::Failing,
                Some("PENDING") => pending = true,
                _ => {}
            }
            continue;
        }

        if let Some(conclusion) = check.conclusion.as_deref() {
            match conclusion.to_ascii_uppercase().as_str() {
                "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => {
                    return CheckState::Failing
                }
                _ => {}
            }
        }

        let completed = check
            .status
            .as_deref()
            .map(|status| status.eq_ignore_ascii_case("COMPLETED"))
            .unwrap_or(false);
        let conclusion_empty = check
            .conclusion
            .as_deref()
            .map(|conclusion| conclusion.trim().is_empty())
            .unwrap_or(true);
        if !completed || conclusion_empty {
            pending = true;
        }
    }

    if pending {
        CheckState::Pending
    } else {
        CheckState::Passing
    }
}

fn parse_logged_in_hosts(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("not logged in") {
                return None;
            }
            let marker = "logged in to ";
            let start = lower.find(marker)? + marker.len();
            let host = line[start..].split_whitespace().next()?.trim();
            (!host.is_empty()).then(|| host.to_string())
        })
        .collect()
}

fn choose_host(hosts: &[String]) -> Option<String> {
    if let Some(host) = hosts
        .iter()
        .find(|host| host.eq_ignore_ascii_case("github.com"))
    {
        return Some(host.clone());
    }

    match hosts {
        [] => None,
        [only] => Some(only.clone()),
        [first, ..] => {
            tracing::warn!(
                target: "sincearc::gh",
                hosts = ?hosts,
                "multiple GitHub hosts are logged in but none is github.com; using the first"
            );
            Some(first.clone())
        }
    }
}

fn cwd_ok() -> bool {
    let Ok(current) = std::env::current_dir() else {
        return false;
    };
    let mut dir = current.as_path();
    loop {
        if dir.join(".git").exists() {
            return true;
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => return false,
        }
    }
}

fn state_arg(state: PrState) -> &'static str {
    match state {
        PrState::Open => "open",
        PrState::Closed => "closed",
        PrState::Merged => "merged",
        PrState::All => "all",
    }
}

fn reset_fragment(stderr: &str) -> String {
    for line in stderr.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(start) = lower.find("resets in").or_else(|| lower.find("resets at")) {
            return line[start..]
                .trim()
                .trim_end_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace())
                .to_string();
        }
    }
    stderr.lines().next().unwrap_or("").trim().to_string()
}

fn map_list_stderr(stderr: &str) -> GhError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("could not resolve to a repository") {
        GhError::RepoUnavailable
    } else if lower.contains("http 401") || lower.contains("bad credentials") {
        GhError::NotLoggedIn
    } else if lower.contains("http 403") && lower.contains("rate limit") {
        GhError::RateLimited {
            reset: reset_fragment(stderr),
        }
    } else {
        GhError::CliFailed {
            stderr: stderr.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl GhCli for RealGh {
    async fn status(&self) -> Result<GhStatus, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };
        let gh_path = Some(path.display().to_string());

        let version_output = self.run(&path, &["--version"], VERSION_TIMEOUT).await?;
        if !version_output.status.success() {
            tracing::warn!(
                target: "sincearc::gh",
                path = %path.display(),
                status = %version_output.status,
                stdout = %version_output.stdout,
                stderr = %version_output.stderr,
                "gh --version failed"
            );
            return Ok(GhStatus {
                available: false,
                version: None,
                logged_in: false,
                gh_path,
                host: None,
                cwd_ok: cwd_ok(),
            });
        }
        let Some(version) = parse_version(&version_output.stdout) else {
            tracing::warn!(
                target: "sincearc::gh",
                path = %path.display(),
                stdout = %version_output.stdout,
                stderr = %version_output.stderr,
                "could not parse gh version output"
            );
            return Ok(GhStatus {
                available: false,
                version: None,
                logged_in: false,
                gh_path,
                host: None,
                cwd_ok: cwd_ok(),
            });
        };

        let auth_output = self.run(&path, &["auth", "status"], AUTH_TIMEOUT).await?;
        let logged_in = auth_output.status.success();
        let host = if logged_in {
            choose_host(&parse_logged_in_hosts(&auth_output.stdout))
        } else {
            None
        };
        if !logged_in {
            tracing::debug!(
                target: "sincearc::gh",
                stderr = %auth_output.stderr,
                "gh auth status reported a non-zero exit"
            );
        }

        Ok(GhStatus {
            available: true,
            version: Some(version),
            logged_in,
            gh_path,
            host,
            cwd_ok: cwd_ok(),
        })
    }

    async fn list_prs(&self, repo: &RepoRef, state: PrState) -> Result<Vec<PullRequest>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = match repo.host.as_deref().map(str::trim) {
            Some(host) if !host.is_empty() => {
                format!("{host}/{}/{}", repo.owner, repo.name)
            }
            _ => format!("{}/{}", repo.owner, repo.name),
        };
        let output = self
            .run(
                &path,
                &[
                    "pr",
                    "list",
                    "-R",
                    &repository,
                    "--limit",
                    LIST_LIMIT,
                    "--state",
                    state_arg(state),
                    "--json",
                    LIST_JSON_FIELDS,
                ],
                LIST_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_list_stderr(&output.stderr));
        }

        let raw: Vec<RawPr> = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh pr list output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw.into_iter().map(RawPr::into_model).collect())
    }
}

impl RealGh {
    async fn version_for_parse_error(&self, path: &Path) -> String {
        match self.run(path, &["--version"], VERSION_TIMEOUT).await {
            Ok(output) if output.status.success() => {
                parse_version(&output.stdout).unwrap_or_else(|| "unknown".to_string())
            }
            _ => "unknown".to_string(),
        }
    }
}

fn default_exe_name() -> OsString {
    #[cfg(windows)]
    {
        OsString::from("gh.exe")
    }
    #[cfg(not(windows))]
    {
        OsString::from("gh")
    }
}

fn production_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        roots.extend(std::env::split_paths(&path).filter(|root| !root.as_os_str().is_empty()));
    }

    if let Some(program_files) = env_dir("ProgramFiles") {
        roots.push(program_files.join("GitHub CLI"));
    }
    if let Some(local_app_data) = env_dir("LOCALAPPDATA") {
        roots.push(local_app_data.join("Programs").join("GitHub CLI"));
    }
    if let Some(user_profile) = env_dir("USERPROFILE") {
        roots.push(user_profile.join("scoop").join("shims"));
    }
    roots
}

fn env_dir(name: &str) -> Option<PathBuf> {
    let value = std::env::var(name).ok()?;
    if value.trim().is_empty() {
        None
    } else {
        Some(PathBuf::from(value))
    }
}

#[cfg(test)]
mod tests {
    #![cfg(windows)]

    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, MutexGuard};

    use super::*;

    const FAKE_GH: &[u8] = include_bytes!("../../tests/fixtures/fake-gh.cmd");
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(name: &str) -> Self {
            let id = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "sincearc-gh-test-{}-{}-{}",
                std::process::id(),
                name,
                id
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn join(&self, path: impl AsRef<Path>) -> PathBuf {
            self.0.join(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn lock_env() -> MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn set_mode(mode: &str) {
        std::env::set_var("FAKE_GH_MODE", mode);
    }

    fn set_fixture(name: &str) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("gh")
            .join(name);
        std::env::set_var("FAKE_GH_FIXTURE", path);
    }

    fn sample_repo() -> RepoRef {
        RepoRef {
            host: Some("github.com".to_string()),
            owner: "wangsyiiz".to_string(),
            name: "SinceArc".to_string(),
        }
    }

    fn stub_gh(name: &str, mode: &str) -> (TestDir, RealGh) {
        set_mode(mode);
        let temp = TestDir::new(name);
        let root = temp.join("bin");
        write_stub(&root, "fake-gh.cmd");
        let gh = RealGh::with_roots_and_exe(vec![root], "fake-gh.cmd");
        (temp, gh)
    }

    struct CwdGuard(PathBuf);

    impl CwdGuard {
        fn change_to(path: &Path) -> Self {
            let original = std::env::current_dir().unwrap();
            std::env::set_current_dir(path).unwrap();
            Self(original)
        }
    }

    impl Drop for CwdGuard {
        fn drop(&mut self) {
            let _ = std::env::set_current_dir(&self.0);
        }
    }

    fn write_stub(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let mut bytes = Vec::with_capacity(FAKE_GH.len() + FAKE_GH.len() / 16);
        for &byte in FAKE_GH {
            if byte == b'\n' && bytes.last() != Some(&b'\r') {
                bytes.push(b'\r');
            }
            bytes.push(byte);
        }
        std::fs::write(dir.join(name), bytes).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn probe_finds_nothing_reports_not_installed() {
        let _lock = lock_env();
        set_mode("ok");
        let temp = TestDir::new("not-installed");
        let empty = temp.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let gh = RealGh::with_roots_and_exe(vec![empty], "fake-gh.cmd");

        let error = gh.status().await.unwrap_err();
        assert_eq!(error, GhError::NotInstalled);
        assert_eq!(error.code(), 50710);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn probe_finds_stub_in_fixed_path_parses_version() {
        let _lock = lock_env();
        set_mode("ok");
        let temp = TestDir::new("fixed-path");
        let path_root = temp.join("path-root");
        let fixed_root = temp.join("program-files").join("GitHub CLI");
        std::fs::create_dir_all(&path_root).unwrap();
        write_stub(&fixed_root, "fake-gh.cmd");
        let expected_path = fixed_root.join("fake-gh.cmd");
        let gh = RealGh::with_roots_and_exe(vec![path_root, fixed_root], "fake-gh.cmd");

        let status = gh.status().await.unwrap();
        assert!(status.available);
        assert_eq!(status.version.as_deref(), Some("2.99.1"));
        assert!(status.logged_in);
        assert_eq!(status.gh_path, Some(expected_path.display().to_string()));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn auth_status_nonzero_means_not_logged_in() {
        let _lock = lock_env();
        set_mode("not-logged-in");
        let temp = TestDir::new("not-logged-in");
        let root = temp.join("bin");
        write_stub(&root, "fake-gh.cmd");
        let gh = RealGh::with_roots_and_exe(vec![root], "fake-gh.cmd");

        let status = gh.status().await.unwrap();
        assert!(status.available);
        assert_eq!(status.version.as_deref(), Some("2.99.1"));
        assert!(!status.logged_in);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn garbage_version_output_is_unavailable() {
        let _lock = lock_env();
        set_mode("garbage-version");
        let temp = TestDir::new("garbage-version");
        let root = temp.join("bin");
        write_stub(&root, "fake-gh.cmd");
        let gh = RealGh::with_roots_and_exe(vec![root], "fake-gh.cmd");

        let status = gh.status().await.unwrap();
        assert!(!status.available);
        assert!(status.version.is_none());
        assert!(!status.logged_in);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn slow_stub_times_out_without_leaking_child() {
        let _lock = lock_env();
        set_mode("slow");
        let temp = TestDir::new("slow");
        let root = temp.join("bin");
        write_stub(&root, "fake-gh.cmd");
        let gh = RealGh::with_roots_and_exe(vec![root], "fake-gh.cmd");

        let error = gh.status().await.unwrap_err();
        assert_eq!(error, GhError::Timeout);
        assert_eq!(error.code(), 50714);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn present_but_unusable_exe_is_unavailable_not_a_crash() {
        let _lock = lock_env();
        set_mode("ok");
        // 不用「垃圾 .exe」造这个场景：Windows 上 CreateProcess 撞上非 PE 文件会卡在系统错误弹窗
        // （实测 300s 不返回），那测的是操作系统的 UX，不是我们的代码 —— 而且能把整条门禁挂住。
        // 改成拿一个真实存在、但把 `--version` 当非法参数的可执行文件冒充 gh：退出码非 0
        // ⇒ 判 available=false，且绝不 panic、不阻塞。
        let me = std::env::current_exe().expect("current_exe");
        let dir = me.parent().expect("parent").to_path_buf();
        let name = me.file_name().expect("file_name").to_os_string();
        let gh = RealGh::with_roots_and_exe(vec![dir], name);

        let status = gh.status().await.expect("不该报错，只是不可用");
        assert!(!status.available);
        assert!(status.version.is_none());
        assert!(!status.logged_in);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn merged_pr_maps_nullable_fields_to_none() {
        let _lock = lock_env();
        set_fixture("pr-list.json");
        let (_temp, gh) = stub_gh("merged-pr", "pr-list");

        let items = gh.list_prs(&sample_repo(), PrState::Open).await.unwrap();
        let first = items.iter().find(|pr| pr.number == 12).unwrap();
        assert_eq!(first.mergeable, None);
        assert_eq!(first.review_decision, None);
        assert_eq!(first.author.login, "wangsyiiz");
        assert!(!first.author.is_bot);
        assert_eq!(first.checks, CheckState::Passing);
        assert_eq!(first.state, PrStateView::Merged);
        assert_eq!(first.updated_at, "2026-10-28T10:03:06Z");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn draft_open_pr_maps_to_draft_state() {
        let _lock = lock_env();
        set_fixture("pr-list-draft-pending.json");
        let (_temp, gh) = stub_gh("draft-pr", "pr-list");

        let items = gh.list_prs(&sample_repo(), PrState::Open).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].state, PrStateView::Draft);
        assert_eq!(items[0].checks, CheckState::Pending);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn empty_list_is_ok() {
        let _lock = lock_env();
        set_fixture("pr-list-empty.json");
        let (_temp, gh) = stub_gh("empty-pr", "pr-list");

        assert!(gh
            .list_prs(&sample_repo(), PrState::Open)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repo_not_found_maps_to_50713() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("repo-missing", "repo-missing");

        let error = gh
            .list_prs(&sample_repo(), PrState::Open)
            .await
            .unwrap_err();
        assert_eq!(error, GhError::RepoUnavailable);
        assert_eq!(error.code(), 50713);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn bad_credentials_maps_to_50711() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("bad-cred", "bad-cred");

        let error = gh
            .list_prs(&sample_repo(), PrState::Open)
            .await
            .unwrap_err();
        assert_eq!(error, GhError::NotLoggedIn);
        assert_eq!(error.code(), 50711);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rate_limit_maps_to_50712() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("rate-limit", "rate-limit");

        let error = gh
            .list_prs(&sample_repo(), PrState::Open)
            .await
            .unwrap_err();
        match &error {
            GhError::RateLimited { reset } => {
                assert!(reset.contains("resets in 42 minutes"), "reset = {reset}");
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        assert_eq!(error.code(), 50712);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn host_prefers_github_com() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("host-github", "ok");

        let status = gh.status().await.unwrap();
        assert!(status.logged_in);
        assert_eq!(status.host.as_deref(), Some("github.com"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn host_falls_back_to_other_host() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("host-other", "auth-other-host");

        let status = gh.status().await.unwrap();
        assert!(status.logged_in);
        assert_eq!(status.host.as_deref(), Some("gitlab.example.com"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn host_none_when_logged_out() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("host-none", "auth-none");

        let status = gh.status().await.unwrap();
        assert!(!status.logged_in);
        assert_eq!(status.host, None);
    }

    #[test]
    fn cwd_ok_true_inside_git_tree() {
        let _lock = lock_env();
        let temp = TestDir::new("cwd-inside");
        let original = std::env::current_dir().unwrap();

        let dir_repo = temp.join("dir-repo");
        std::fs::create_dir_all(dir_repo.join(".git")).unwrap();
        let nested = dir_repo.join("src").join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let file_repo = temp.join("file-repo");
        std::fs::create_dir_all(file_repo.join("sub")).unwrap();
        std::fs::write(file_repo.join(".git"), "gitdir: ../worktree\n").unwrap();

        let inside_dir = {
            let _cwd = CwdGuard::change_to(nested.as_path());
            cwd_ok()
        };
        let inside_file = {
            let _cwd = CwdGuard::change_to(file_repo.join("sub").as_path());
            cwd_ok()
        };

        assert_eq!(std::env::current_dir().unwrap(), original);
        assert!(inside_dir);
        assert!(inside_file);
    }

    #[test]
    fn cwd_ok_false_outside() {
        let _lock = lock_env();
        let temp = TestDir::new("cwd-outside");
        let outside = temp.join("plain");
        std::fs::create_dir_all(&outside).unwrap();
        let original = std::env::current_dir().unwrap();

        let result = {
            let _cwd = CwdGuard::change_to(outside.as_path());
            cwd_ok()
        };
        assert_eq!(std::env::current_dir().unwrap(), original);

        assert!(!result);
    }
}
