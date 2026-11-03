//! gh adapter：唯一与进程、argv、超时和原始输出打交道的地方。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::model::{
    ActionResult, Capability, CheckState, DenyReason, FileChange, GhAction, GhActionParams, GhCli,
    GhError, GhStatus, Issue, IssueState, IssueStateView, LatestRelease, MyPullRequest, PrDetail,
    PrState, PrStateView, PullRequest, Release, RepoCounts, RepoListing, RepoMeta, RepoRef,
    TreeEntry, TreeEntryKind, Viewer, Workflow, WorkflowRun, MAX_REPO_LIST_LIMIT,
};
use serde::Deserialize;

/// Windows：GUI 进程 spawn 控制台程序时，不给这个标志就会弹一个黑框（一闪而过）。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
const DETAIL_TIMEOUT: Duration = Duration::from_secs(10);
const DIFF_TIMEOUT: Duration = Duration::from_secs(20);
const REPO_LIST_TIMEOUT: Duration = Duration::from_secs(15);
const VIEWER_TIMEOUT: Duration = Duration::from_secs(10);
const REPO_META_TIMEOUT: Duration = Duration::from_secs(10);
const REPO_COUNTS_TIMEOUT: Duration = Duration::from_secs(15);
const ISSUE_LIST_TIMEOUT: Duration = Duration::from_secs(10);
const RELEASE_LIST_TIMEOUT: Duration = Duration::from_secs(15);
const RUN_LIST_TIMEOUT: Duration = Duration::from_secs(15);
const WORKFLOW_LIST_TIMEOUT: Duration = Duration::from_secs(10);
const TREE_TIMEOUT: Duration = Duration::from_secs(10);
/// `gh search prs` 跨全部可访问仓库；实测 1.84s，留足余量（docs/gh.md §13）。
const MY_PR_SEARCH_TIMEOUT: Duration = Duration::from_secs(20);
const LIST_LIMIT: &str = "30";
const LIST_JSON_FIELDS: &str = "number,title,state,isDraft,mergeable,reviewDecision,author,updatedAt,headRefName,baseRefName,url,statusCheckRollup";
const DETAIL_JSON_FIELDS: &str = "number,title,state,isDraft,mergeable,reviewDecision,author,updatedAt,createdAt,headRefName,baseRefName,url,statusCheckRollup,body,additions,deletions,changedFiles,files";
const REPO_LIST_JSON_FIELDS: &str =
    "nameWithOwner,isPrivate,defaultBranchRef,updatedAt,description";
const REPO_META_JSON_FIELDS: &str = "nameWithOwner,description,visibility,defaultBranchRef,pushedAt,stargazerCount,forkCount,isArchived,hasIssuesEnabled,repositoryTopics,latestRelease";
const ISSUE_JSON_FIELDS: &str = "number,title,state,author,labels,updatedAt,url";
const RELEASE_JSON_FIELDS: &str = "tagName,name,publishedAt,isLatest,isDraft,isPrerelease";
const RUN_JSON_FIELDS: &str =
    "databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url";
const WORKFLOW_JSON_FIELDS: &str = "name,path,state,id";
const TREE_JSON_FIELDS: &str = "name,path,size,gitType";
const MY_PR_JSON_FIELDS: &str = "number,title,repository,url,updatedAt,isDraft";
const MAX_ACTION_BODY_BYTES: usize = 64 * 1024;

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
        // 不设这个标志，`gh --version` / `auth status` / `repo list` 每跑一次都会闪一个控制台窗口。
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

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
    let core = version.split(['-', '+']).next()?;
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
struct RawViewer {
    login: String,
    name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMyPr {
    number: u32,
    title: String,
    repository: RawMyPrRepo,
    url: String,
    updated_at: String,
    is_draft: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawMyPrRepo {
    name_with_owner: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepoListing {
    name_with_owner: String,
    is_private: bool,
    default_branch_ref: Option<RawBranchRef>,
    updated_at: Option<String>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawBranchRef {
    name: String,
}

impl RawRepoListing {
    fn into_model(self, host: &str) -> Option<RepoListing> {
        let (owner, name) = self.name_with_owner.split_once('/')?;
        if owner.trim().is_empty() || name.trim().is_empty() {
            return None;
        }
        Some(RepoListing {
            repo: RepoRef {
                host: Some(host.to_string()),
                owner: owner.to_string(),
                name: name.to_string(),
            },
            default_branch: self
                .default_branch_ref
                .map(|branch| branch.name.trim().to_string())
                .filter(|branch| !branch.is_empty()),
            is_private: self.is_private,
            updated_at: self.updated_at.as_deref().and_then(parse_iso8601_epoch),
            description: self
                .description
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        })
    }
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFile {
    path: String,
    additions: u32,
    deletions: u32,
    change_type: String,
}

impl RawFile {
    fn into_model(self) -> FileChange {
        FileChange {
            path: self.path,
            additions: self.additions,
            deletions: self.deletions,
            change_type: self.change_type.to_ascii_lowercase(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawDetail {
    #[serde(flatten)]
    pr: RawPr,
    body: String,
    created_at: String,
    additions: u32,
    deletions: u32,
    changed_files: u32,
    files: Vec<RawFile>,
}

impl RawDetail {
    fn into_model(self) -> PrDetail {
        let files: Vec<FileChange> = self.files.into_iter().map(RawFile::into_model).collect();
        let files_truncated = files.len() != self.changed_files as usize;

        PrDetail {
            pr: self.pr.into_model(),
            body: self.body,
            created_at: self.created_at,
            additions: self.additions,
            deletions: self.deletions,
            changed_files: self.changed_files,
            files,
            files_truncated,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRepoMeta {
    name_with_owner: String,
    description: Option<String>,
    visibility: String,
    default_branch_ref: Option<RawBranchRef>,
    pushed_at: Option<String>,
    stargazer_count: u64,
    fork_count: u64,
    is_archived: bool,
    has_issues_enabled: bool,
    repository_topics: Option<Vec<RawRepoTopic>>,
    latest_release: Option<RawLatestRelease>,
}

#[derive(Debug, Deserialize)]
struct RawRepoTopic {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    topic: Option<RawTopicName>,
}

#[derive(Debug, Deserialize)]
struct RawTopicName {
    name: String,
}

impl RawRepoTopic {
    fn into_name(self) -> Option<String> {
        self.name
            .or_else(|| self.topic.map(|topic| topic.name))
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLatestRelease {
    tag_name: String,
    name: Option<String>,
    published_at: Option<String>,
}

impl RawRepoMeta {
    fn into_model(self) -> RepoMeta {
        let topics = self
            .repository_topics
            .unwrap_or_default()
            .into_iter()
            .filter_map(RawRepoTopic::into_name)
            .collect();
        let latest_release = self.latest_release.map(|release| LatestRelease {
            tag_name: release.tag_name.trim().to_string(),
            name: release
                .name
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| release.tag_name.trim().to_string()),
            published_at: clean_optional(release.published_at),
        });

        RepoMeta {
            name_with_owner: self.name_with_owner.trim().to_string(),
            description: clean_optional(self.description),
            visibility: self.visibility.trim().to_string(),
            default_branch: self
                .default_branch_ref
                .map(|branch| branch.name.trim().to_string())
                .filter(|branch| !branch.is_empty())
                .unwrap_or_default(),
            topics,
            pushed_at: self.pushed_at.unwrap_or_default(),
            stargazers: self.stargazer_count,
            forks: self.fork_count,
            is_archived: self.is_archived,
            has_issues: self.has_issues_enabled,
            latest_release,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawGraphqlEnvelope {
    data: Option<RawGraphqlData>,
}

#[derive(Debug, Deserialize)]
struct RawGraphqlData {
    repository: Option<RawGraphqlRepoCounts>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawGraphqlRepoCounts {
    pull_requests: Option<RawTotalCount>,
    issues: Option<RawTotalCount>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTotalCount {
    total_count: u32,
}

fn parse_graphql_counts(stdout: &str) -> Result<RepoCounts, ()> {
    let envelope: RawGraphqlEnvelope = serde_json::from_str(stdout).map_err(|_| ())?;
    let data = envelope.data.ok_or(())?;
    let repository = data.repository.ok_or(())?;
    Ok(RepoCounts {
        open_prs: repository.pull_requests.map(|count| count.total_count),
        open_issues: repository.issues.map(|count| count.total_count),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawIssue {
    number: u32,
    title: String,
    state: String,
    author: RawAuthor,
    labels: Option<Vec<RawLabel>>,
    updated_at: String,
    url: String,
}

#[derive(Debug, Deserialize)]
struct RawLabel {
    name: String,
}

impl RawIssue {
    fn into_model(self) -> Issue {
        Issue {
            number: self.number,
            title: self.title,
            state: if self.state.eq_ignore_ascii_case("CLOSED") {
                IssueStateView::Closed
            } else {
                IssueStateView::Open
            },
            author: super::model::Author {
                login: self.author.login,
                name: clean_optional(self.author.name),
                is_bot: self.author.is_bot,
            },
            labels: self
                .labels
                .unwrap_or_default()
                .into_iter()
                .map(|label| label.name)
                .filter(|name| !name.trim().is_empty())
                .collect(),
            updated_at: self.updated_at,
            url: self.url,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRelease {
    tag_name: String,
    name: String,
    published_at: Option<String>,
    #[serde(default)]
    is_latest: bool,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    is_prerelease: bool,
}

impl RawRelease {
    fn into_model(self) -> Release {
        Release {
            tag_name: self.tag_name,
            name: self.name,
            published_at: clean_optional(self.published_at),
            is_latest: self.is_latest,
            is_draft: self.is_draft,
            is_prerelease: self.is_prerelease,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRun {
    database_id: u64,
    display_title: String,
    workflow_name: Option<String>,
    status: String,
    conclusion: Option<String>,
    head_branch: Option<String>,
    event: String,
    created_at: String,
    url: String,
}

impl RawRun {
    fn into_model(self) -> WorkflowRun {
        WorkflowRun {
            id: self.database_id,
            workflow_name: clean_optional(self.workflow_name),
            title: self.display_title,
            status: self.status,
            conclusion: clean_optional(self.conclusion),
            branch: clean_optional(self.head_branch),
            event: self.event,
            created_at: self.created_at,
            url: self.url,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawWorkflow {
    id: u64,
    name: String,
    path: String,
    state: String,
}

impl RawWorkflow {
    fn into_model(self) -> Workflow {
        Workflow {
            id: self.id,
            name: self.name,
            path: self.path,
            state: self.state,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTreeEntry {
    name: String,
    path: String,
    size: Option<u64>,
    git_type: String,
}

impl RawTreeEntry {
    fn into_model(self) -> TreeEntry {
        let kind = if self.git_type.eq_ignore_ascii_case("tree")
            || self.git_type.eq_ignore_ascii_case("dir")
        {
            TreeEntryKind::Dir
        } else {
            TreeEntryKind::File
        };
        TreeEntry {
            name: self.name,
            path: self.path,
            kind,
            size: if kind == TreeEntryKind::Dir {
                None
            } else {
                self.size
            },
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawTreeResponse {
    Entries { entries: Vec<RawTreeEntry> },
    List(Vec<RawTreeEntry>),
}

impl RawTreeResponse {
    fn into_models(self) -> Vec<TreeEntry> {
        match self {
            Self::Entries { entries } | Self::List(entries) => {
                entries.into_iter().map(RawTreeEntry::into_model).collect()
            }
        }
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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

/// `gh repo list` 不会在 JSON 里带 host；优先 `GH_HOST`，否则按 github.com。
/// 只读环境变量，不碰 `~/.config/gh/hosts.yml`（docs/gh.md §2.2 的边界）。
fn current_repo_host() -> String {
    std::env::var("GH_HOST")
        .ok()
        .map(|host| host.trim().to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .unwrap_or_else(|| "github.com".to_string())
}

/// ISO8601（UTC `Z` 或 `±HH:MM`）→ epoch 秒。`gh` 给的是字符串，
/// 但域模型只暴露数值时间；解析失败按缺失处理，不让整个列表失败。
fn parse_iso8601_epoch(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (date, time) = raw.split_once('T').or_else(|| raw.split_once(' '))?;
    let mut date_parts = date.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if date_parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    let (clock, offset_secs) = split_time_offset(time)?;
    let mut time_parts = clock.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next()?.split('.').next()?.parse().ok()?;
    if time_parts.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }

    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second - offset_secs)
}

fn split_time_offset(time: &str) -> Option<(&str, i64)> {
    if let Some(clock) = time.strip_suffix('Z').or_else(|| time.strip_suffix('z')) {
        return Some((clock, 0));
    }
    if let Some(index) = time.rfind(['+', '-']) {
        let (clock, offset) = time.split_at(index);
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let (hours, minutes) = offset[1..].split_once(':')?;
        let hours: i64 = hours.parse().ok()?;
        let minutes: i64 = minutes.parse().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        return Some((clock, sign * (hours * 3_600 + minutes * 60)));
    }
    Some((time, 0))
}

/// Howard Hinnant 的 civil-date 算法：1970-01-01 为第 0 天。
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = (if month <= 2 { year - 1 } else { year }) as i64;
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let year_of_era = year - era * 400;
    let month = month as i64;
    let day = day as i64;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
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

fn issue_state_arg(state: IssueState) -> &'static str {
    match state {
        IssueState::Open => "open",
        IssueState::Closed => "closed",
        IssueState::All => "all",
    }
}

fn graphql_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn counts_query(repo: &RepoRef) -> String {
    format!(
        "query {{ repository(owner: \"{}\", name: \"{}\") {{ pullRequests(states: OPEN) {{ totalCount }} issues(states: OPEN) {{ totalCount }} }} }}",
        graphql_escape(repo.owner.trim()),
        graphql_escape(repo.name.trim())
    )
}

fn bad_action_params(action: GhAction, field: &str, detail: impl Into<String>) -> GhError {
    GhError::BadActionParams {
        action,
        field: field.to_string(),
        detail: detail.into(),
    }
}

fn validate_body(action: GhAction, body: &str) -> Result<(), GhError> {
    if body.trim().is_empty() {
        return Err(bad_action_params(action, "body", "评论正文不能为空"));
    }
    if body.len() > MAX_ACTION_BODY_BYTES {
        return Err(bad_action_params(
            action,
            "body",
            format!("评论正文不能超过 {MAX_ACTION_BODY_BYTES} 字节"),
        ));
    }
    Ok(())
}

fn validate_number(action: GhAction, number: u32) -> Result<(), GhError> {
    if number == 0 {
        return Err(bad_action_params(action, "number", "编号必须大于 0"));
    }
    Ok(())
}

/// §11.4 的顺序：仓库/动作合法性 → 参数校验（50721）→ 未开放（50720）。
/// 首版不执行任何写动作，所以校验通过后一律返回 Readonly。
fn validate_action_params(repo: &RepoRef, params: &GhActionParams) -> Result<(), GhError> {
    let action = params.action();
    if repo.owner.trim().is_empty() || repo.name.trim().is_empty() {
        return Err(bad_action_params(action, "repo", "仓库不能为空"));
    }

    match params {
        GhActionParams::PrComment { number, body }
        | GhActionParams::IssueComment { number, body } => {
            validate_number(action, *number)?;
            validate_body(action, body)?;
        }
        GhActionParams::PrReview {
            number,
            verdict: _,
            body,
        } => {
            validate_number(action, *number)?;
            if let Some(body) = body {
                validate_body(action, body)?;
            }
        }
        GhActionParams::PrMerge {
            number,
            method: _,
            match_head_commit,
            delete_branch: _,
        } => {
            validate_number(action, *number)?;
            if match_head_commit.trim().is_empty() {
                return Err(bad_action_params(
                    action,
                    "match_head_commit",
                    "合并必须带上要匹配的 head commit",
                ));
            }
        }
        GhActionParams::PrClose { number } | GhActionParams::PrReopen { number } => {
            validate_number(action, *number)?;
        }
        GhActionParams::IssueClose { number } => {
            validate_number(action, *number)?;
        }
        GhActionParams::WorkflowDispatch {
            workflow,
            git_ref,
            inputs: _,
        } => {
            if workflow.trim().is_empty() {
                return Err(bad_action_params(action, "workflow", "workflow 不能为空"));
            }
            if git_ref.trim().is_empty() {
                return Err(bad_action_params(
                    action,
                    "git_ref",
                    "workflow_dispatch 必须指定 ref",
                ));
            }
        }
        GhActionParams::RunRerun {
            run_id,
            failed_only: _,
        } => {
            if *run_id == 0 {
                return Err(bad_action_params(action, "run_id", "run_id 必须大于 0"));
            }
        }
    }

    Ok(())
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

fn map_stderr(stderr: &str) -> GhError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("could not resolve to a pullrequest") {
        GhError::PrNotFound
    } else if lower.contains("could not resolve to a repository") {
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

fn repository_arg(repo: &RepoRef) -> String {
    match repo.host.as_deref().map(str::trim) {
        Some(host) if !host.is_empty() => format!("{host}/{}/{}", repo.owner, repo.name),
        _ => format!("{}/{}", repo.owner, repo.name),
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

    async fn viewer(&self) -> Result<Viewer, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let output = self.run(&path, &["api", "user"], VIEWER_TIMEOUT).await?;
        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: RawViewer = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh api user output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        let login = raw.login.trim().to_string();
        if login.is_empty() {
            tracing::warn!(
                target: "sincearc::gh",
                "gh api user returned an empty login"
            );
            return Err(GhError::ParseFailed {
                version: self.version_for_parse_error(&path).await,
            });
        }

        let clean = |value: Option<String>| {
            value
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        Ok(Viewer {
            login,
            name: clean(raw.name),
            avatar_url: clean(raw.avatar_url),
        })
    }

    async fn search_my_open_prs(&self, limit: u32) -> Result<Vec<MyPullRequest>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let limit = limit.max(1).to_string();
        let output = self
            .run(
                &path,
                &[
                    "search",
                    "prs",
                    "--author",
                    "@me",
                    "--state",
                    "open",
                    "--limit",
                    limit.as_str(),
                    "--json",
                    MY_PR_JSON_FIELDS,
                ],
                MY_PR_SEARCH_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: Vec<RawMyPr> = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh search prs output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw
            .into_iter()
            .map(|row| MyPullRequest {
                number: row.number,
                title: row.title,
                url: row.url,
                updated_at: parse_iso8601_epoch(&row.updated_at).unwrap_or(0),
                is_draft: row.is_draft,
                repo: row.repository.name_with_owner,
            })
            .collect())
    }

    async fn list_repos(
        &self,
        owner: Option<&str>,
        limit: u32,
    ) -> Result<Vec<RepoListing>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let limit = limit.clamp(1, MAX_REPO_LIST_LIMIT).to_string();
        let mut args = vec!["repo", "list"];
        if let Some(owner) = owner.map(str::trim).filter(|owner| !owner.is_empty()) {
            args.push(owner);
        }
        args.extend(["--limit", limit.as_str(), "--json", REPO_LIST_JSON_FIELDS]);

        let output = self.run(&path, &args, REPO_LIST_TIMEOUT).await?;
        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: Vec<RawRepoListing> = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh repo list output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        let host = current_repo_host();
        Ok(raw
            .into_iter()
            .filter_map(|row| {
                let name_with_owner = row.name_with_owner.clone();
                let listing = row.into_model(&host);
                if listing.is_none() {
                    tracing::warn!(
                        target: "sincearc::gh",
                        name_with_owner = %name_with_owner,
                        "gh repo list row has no owner/name"
                    );
                }
                listing
            })
            .collect())
    }

    async fn list_prs(&self, repo: &RepoRef, state: PrState) -> Result<Vec<PullRequest>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
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
            return Err(map_stderr(&output.stderr));
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

    async fn pr_detail(&self, repo: &RepoRef, number: u32) -> Result<PrDetail, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let number = number.to_string();
        let output = self
            .run(
                &path,
                &[
                    "pr",
                    "view",
                    &number,
                    "-R",
                    &repository,
                    "--json",
                    DETAIL_JSON_FIELDS,
                ],
                DETAIL_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: RawDetail = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh pr view output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw.into_model())
    }

    async fn pr_diff(&self, repo: &RepoRef, number: u32) -> Result<String, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let number = number.to_string();
        let output = self
            .run(
                &path,
                &["pr", "diff", &number, "-R", &repository],
                DIFF_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        Ok(output.stdout)
    }

    async fn repo_meta(&self, repo: &RepoRef) -> Result<RepoMeta, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let output = self
            .run(
                &path,
                &["repo", "view", &repository, "--json", REPO_META_JSON_FIELDS],
                REPO_META_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: RawRepoMeta = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh repo view output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw.into_model())
    }

    async fn repo_counts(&self, repo: &RepoRef) -> Result<RepoCounts, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        // `gh api` 默认打 github.com；跨 host（GitHub Enterprise）必须显式 --hostname，
        // 否则计数会拿错主机（表现为 50713 或者干脆 404）。其余命令用 `-R host/owner/repo` 自带主机。
        let query = format!("query={}", counts_query(repo));
        let host = repo
            .host
            .as_deref()
            .map(str::trim)
            .filter(|host| !host.is_empty() && !host.eq_ignore_ascii_case("github.com"));
        let mut args = vec!["api", "graphql", "-f", query.as_str()];
        if let Some(host) = host {
            args.extend(["--hostname", host]);
        }
        let output = self.run(&path, &args, REPO_COUNTS_TIMEOUT).await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        match parse_graphql_counts(&output.stdout) {
            Ok(counts) => Ok(counts),
            Err(_) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    stdout = %output.stdout,
                    "could not parse gh api graphql counts output"
                );
                Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                })
            }
        }
    }

    async fn list_issues(
        &self,
        repo: &RepoRef,
        state: IssueState,
        limit: u32,
    ) -> Result<Vec<Issue>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let limit = limit.to_string();
        let output = self
            .run(
                &path,
                &[
                    "issue",
                    "list",
                    "-R",
                    &repository,
                    "--state",
                    issue_state_arg(state),
                    "--limit",
                    &limit,
                    "--json",
                    ISSUE_JSON_FIELDS,
                ],
                ISSUE_LIST_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: Vec<RawIssue> = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh issue list output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw.into_iter().map(RawIssue::into_model).collect())
    }

    async fn list_releases(&self, repo: &RepoRef, limit: u32) -> Result<Vec<Release>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let limit = limit.to_string();
        let output = self
            .run(
                &path,
                &[
                    "release",
                    "list",
                    "-R",
                    &repository,
                    "--limit",
                    &limit,
                    "--json",
                    RELEASE_JSON_FIELDS,
                ],
                RELEASE_LIST_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: Vec<RawRelease> = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh release list output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw.into_iter().map(RawRelease::into_model).collect())
    }

    async fn list_runs(&self, repo: &RepoRef, limit: u32) -> Result<Vec<WorkflowRun>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let limit = limit.to_string();
        let output = self
            .run(
                &path,
                &[
                    "run",
                    "list",
                    "-R",
                    &repository,
                    "--limit",
                    &limit,
                    "--json",
                    RUN_JSON_FIELDS,
                ],
                RUN_LIST_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: Vec<RawRun> = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh run list output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw.into_iter().map(RawRun::into_model).collect())
    }

    async fn list_workflows(&self, repo: &RepoRef) -> Result<Vec<Workflow>, GhError> {
        let Some(path) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let output = self
            .run(
                &path,
                &[
                    "workflow",
                    "list",
                    "-R",
                    &repository,
                    "--json",
                    WORKFLOW_JSON_FIELDS,
                ],
                WORKFLOW_LIST_TIMEOUT,
            )
            .await?;

        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: Vec<RawWorkflow> = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh workflow list output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&path).await,
                });
            }
        };

        Ok(raw.into_iter().map(RawWorkflow::into_model).collect())
    }

    async fn repo_tree(
        &self,
        repo: &RepoRef,
        path: Option<&str>,
        git_ref: Option<&str>,
    ) -> Result<Vec<TreeEntry>, GhError> {
        let Some(exe) = self.find() else {
            return Err(GhError::NotInstalled);
        };

        let repository = repository_arg(repo);
        let mut args = vec!["repo", "read-dir"];
        if let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) {
            args.push(path);
        }
        args.extend(["-R", repository.as_str()]);
        if let Some(git_ref) = git_ref.map(str::trim).filter(|value| !value.is_empty()) {
            args.extend(["--ref", git_ref]);
        }
        args.extend(["--json", TREE_JSON_FIELDS]);

        let output = self.run(&exe, &args, TREE_TIMEOUT).await?;
        if !output.status.success() {
            return Err(map_stderr(&output.stderr));
        }

        let raw: RawTreeResponse = match serde_json::from_str(&output.stdout) {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not parse gh repo read-dir output"
                );
                return Err(GhError::ParseFailed {
                    version: self.version_for_parse_error(&exe).await,
                });
            }
        };

        Ok(raw.into_models())
    }

    async fn capabilities(&self, _repo: &RepoRef) -> Result<Vec<Capability>, GhError> {
        // 首版不查 scope（§11.3）：所有写动作一律只读。
        Ok(GhAction::ALL
            .into_iter()
            .map(|action| Capability {
                action,
                allowed: false,
                reason: Some(DenyReason::Readonly),
            })
            .collect())
    }

    async fn action(
        &self,
        repo: &RepoRef,
        params: &GhActionParams,
    ) -> Result<ActionResult, GhError> {
        // 校验在前、拒绝在后（§11.4）；首版不启动任何写进程。
        validate_action_params(repo, params)?;
        Err(GhError::ActionDenied {
            action: params.action(),
            reason: DenyReason::Readonly,
        })
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
mod iso_tests {
    use super::parse_iso8601_epoch;

    #[test]
    fn parses_utc_fractional_and_offset_timestamps() {
        assert_eq!(
            parse_iso8601_epoch("2026-10-28T10:03:06Z"),
            Some(1_793_181_786)
        );
        assert_eq!(
            parse_iso8601_epoch("2026-10-28T10:03:06.789Z"),
            Some(1_793_181_786)
        );
        assert_eq!(
            parse_iso8601_epoch("2026-10-28T10:03:06+08:00"),
            Some(1_793_152_986)
        );
        assert_eq!(parse_iso8601_epoch("not-a-time"), None);
    }
}

#[cfg(test)]
mod dashboard_tests {
    use super::*;

    fn sample_repo() -> RepoRef {
        RepoRef {
            host: Some("github.com".to_string()),
            owner: "acme".to_string(),
            name: "repo".to_string(),
        }
    }

    #[test]
    fn counts_are_used_as_is_without_subtracting_prs() {
        let raw = r#"{"data":{"repository":{"pullRequests":{"totalCount":53},"issues":{"totalCount":1045}}}}"#;
        let counts = parse_graphql_counts(raw).unwrap();
        assert_eq!(counts.open_prs, Some(53));
        assert_eq!(counts.open_issues, Some(1045));
    }

    #[test]
    fn counts_missing_data_is_an_error() {
        assert!(parse_graphql_counts(r#"{"errors":[{"message":"boom"}]}"#).is_err());
        assert!(parse_graphql_counts(r#"{"data":null}"#).is_err());
        assert!(parse_graphql_counts(r#"{"data":{"repository":null}}"#).is_err());
    }

    #[tokio::test]
    async fn action_rejects_bad_params_before_readonly() {
        let gh = RealGh::new();
        let repo = sample_repo();

        let bad_body = gh
            .action(
                &repo,
                &GhActionParams::PrComment {
                    number: 1,
                    body: "   ".to_string(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(bad_body.code(), 50721);

        let bad_number = gh
            .action(&repo, &GhActionParams::PrClose { number: 0 })
            .await
            .unwrap_err();
        assert_eq!(bad_number.code(), 50721);

        let missing_head = gh
            .action(
                &repo,
                &GhActionParams::PrMerge {
                    number: 1,
                    method: crate::gh::model::MergeMethod::Squash,
                    match_head_commit: " ".to_string(),
                    delete_branch: false,
                },
            )
            .await
            .unwrap_err();
        assert_eq!(missing_head.code(), 50721);
    }

    #[tokio::test]
    async fn action_with_valid_params_is_readonly_50720() {
        let gh = RealGh::new();
        let error = gh
            .action(&sample_repo(), &GhActionParams::PrClose { number: 1 })
            .await
            .unwrap_err();
        assert_eq!(error.code(), 50720);
        assert!(matches!(
            error,
            GhError::ActionDenied {
                reason: DenyReason::Readonly,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn capabilities_are_all_readonly() {
        let gh = RealGh::new();
        let capabilities = gh.capabilities(&sample_repo()).await.unwrap();
        assert_eq!(capabilities.len(), GhAction::ALL.len());
        assert!(capabilities.iter().all(|capability| {
            !capability.allowed && matches!(capability.reason.as_ref(), Some(DenyReason::Readonly))
        }));
    }
}

// 测试要串行化进程级环境变量（ENV_LOCK），持锁跨 await 是有意的：
// 锁保护的是「设 env → 跑假 gh → 断言」整个序列，中途放开就失去意义。
#[cfg(all(test, windows))]
#[allow(clippy::await_holding_lock)]
mod tests {

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

    fn set_fixture_path(path: &Path) {
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
    async fn detail_parses_real_fixture() {
        let _lock = lock_env();
        set_fixture("pr-detail.json");
        let (_temp, gh) = stub_gh("pr-detail", "pr-detail");

        let detail = gh.pr_detail(&sample_repo(), 12).await.unwrap();
        assert_eq!(detail.pr.number, 12);
        assert_eq!(detail.files.len(), 13);
        assert_eq!(detail.changed_files, 13);
        assert!(!detail.files_truncated);
        assert_eq!(detail.additions, 803);
        assert_eq!(detail.deletions, 3);
        assert_eq!(detail.created_at, "2026-10-28T10:00:28Z");
        assert_eq!(detail.body.chars().count(), 2376);
        assert_eq!(detail.pr.mergeable, None);
        assert_eq!(detail.pr.review_decision, None);
        assert_eq!(detail.files[0].path, ".gitattributes");
        assert_eq!(detail.files[0].change_type, "added");
        assert_eq!(detail.files[0].additions, 1);
        assert_eq!(detail.files[0].deletions, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn detail_files_truncated_when_counts_differ() {
        let _lock = lock_env();
        let temp = TestDir::new("pr-detail-truncated");
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("gh")
            .join("pr-detail.json");
        let source = std::fs::read_to_string(&fixture).unwrap();
        let altered = source.replacen("\"changedFiles\": 13", "\"changedFiles\": 20", 1);
        assert_ne!(altered, source, "fixture must contain changedFiles=13");
        let path = temp.join("pr-detail-truncated.json");
        std::fs::write(&path, altered).unwrap();
        set_fixture_path(&path);
        let (_temp, gh) = stub_gh("pr-detail-truncated-gh", "pr-detail");

        let detail = gh.pr_detail(&sample_repo(), 12).await.unwrap();
        assert_eq!(detail.files.len(), 13);
        assert_eq!(detail.changed_files, 20);
        assert!(detail.files_truncated);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn detail_pr_not_found_maps_to_50716() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("pr-not-found", "pr-not-found");

        let error = gh.pr_detail(&sample_repo(), 1).await.unwrap_err();
        assert_eq!(error, GhError::PrNotFound);
        assert_eq!(error.code(), 50716);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn detail_repo_not_found_stays_50713() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("pr-repo-missing", "repo-missing");

        let error = gh.pr_detail(&sample_repo(), 1).await.unwrap_err();
        assert_eq!(error, GhError::RepoUnavailable);
        assert_eq!(error.code(), 50713);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn diff_returns_raw_text_unchanged() {
        let _lock = lock_env();
        set_fixture("pr-diff.txt");
        let (_temp, gh) = stub_gh("pr-diff", "pr-diff");
        let expected = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("gh")
                .join("pr-diff.txt"),
        )
        .unwrap();

        let diff = gh.pr_diff(&sample_repo(), 12).await.unwrap();
        assert_eq!(diff.as_bytes(), expected.as_slice());
        assert_eq!(diff.lines().count(), 974);
        assert!(diff.ends_with('\n'));
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

    #[tokio::test(flavor = "current_thread")]
    async fn viewer_parses_login_name_and_avatar() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("viewer-ok", "ok");

        let viewer = gh.viewer().await.unwrap();
        assert_eq!(viewer.login, "wangsyiiz");
        assert_eq!(viewer.name.as_deref(), Some("X"));
        assert_eq!(
            viewer.avatar_url.as_deref(),
            Some("https://avatars.githubusercontent.com/u/1?v=4")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn viewer_401_maps_to_not_logged_in() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("viewer-401", "bad-cred");

        assert_eq!(gh.viewer().await.unwrap_err(), GhError::NotLoggedIn);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn viewer_empty_login_is_parse_failed() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("viewer-empty-login", "empty-login");

        let error = gh.viewer().await.unwrap_err();
        assert!(matches!(
            error,
            GhError::ParseFailed { ref version } if version == "2.99.1"
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repo_list_parses_fixture_and_epoch_seconds() {
        let _lock = lock_env();
        set_fixture("repos.json");
        let (_temp, gh) = stub_gh("repo-list", "ok");

        let items = gh.list_repos(None, 100).await.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].repo.owner, "wangsyiiz");
        assert_eq!(items[0].repo.name, "SinceArc");
        assert_eq!(items[0].repo.host, Some(current_repo_host()));
        assert_eq!(items[0].default_branch.as_deref(), Some("main"));
        assert!(!items[0].is_private);
        assert_eq!(items[0].updated_at, Some(1_793_181_786));
        assert_eq!(items[0].description.as_deref(), Some("ACP desktop client"));

        assert_eq!(items[1].default_branch, None);
        assert!(items[1].is_private);
        assert_eq!(items[1].description, None);
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

    fn write_fixture(dir: &TestDir, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn set_argv_log(path: &Path) {
        std::env::set_var("FAKE_GH_ARGV_LOG", path);
    }

    fn argv_log(dir: &TestDir) -> String {
        // Windows 的 `echo %*` 会把带空格的参数用双引号包起来，嵌套引号还会再被包一层
        // （`-f "query=query { … owner: ""acme"" … }"`）。断言关心的是参数内容而不是 cmd 的转义
        // 形式，所以先抹掉引号再比；不带空格的参数不受影响。
        std::fs::read_to_string(dir.join("argv.log"))
            .unwrap()
            .replace('"', "")
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repo_meta_argv_and_mapping() {
        let _lock = lock_env();
        set_mode("ok");
        let temp = TestDir::new("repo-meta-argv");
        let fixture = write_fixture(
            &temp,
            "repo-meta.json",
            r#"{"nameWithOwner":"acme/repo","description":"demo","visibility":"PUBLIC","defaultBranchRef":{"name":"main"},"pushedAt":"2026-11-03T00:00:00Z","stargazerCount":10,"forkCount":2,"isArchived":false,"hasIssuesEnabled":true,"repositoryTopics":[{"name":"rust"},{"topic":{"name":"tauri"}}],"latestRelease":{"tagName":"v1","name":"One","publishedAt":"2026-11-01T00:00:00Z"}}"#,
        );
        set_fixture_path(&fixture);
        set_argv_log(&temp.join("argv.log"));
        let (_temp, gh) = stub_gh("repo-meta-gh", "ok");

        let meta = gh.repo_meta(&sample_repo()).await.unwrap();
        assert_eq!(meta.name_with_owner, "acme/repo");
        assert_eq!(meta.description.as_deref(), Some("demo"));
        assert_eq!(meta.default_branch, "main");
        assert_eq!(meta.topics, vec!["rust", "tauri"]);
        assert_eq!(meta.stargazers, 10);
        assert_eq!(meta.forks, 2);
        assert!(meta.has_issues);
        assert_eq!(
            meta.latest_release.as_ref().map(|r| r.tag_name.as_str()),
            Some("v1")
        );

        let log = argv_log(&temp);
        assert!(log.contains("repo view github.com/wangsyiiz/SinceArc --json nameWithOwner,description,visibility,defaultBranchRef,pushedAt,stargazerCount,forkCount,isArchived,hasIssuesEnabled,repositoryTopics,latestRelease"), "argv = {log}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repo_counts_argv_and_parse() {
        let _lock = lock_env();
        set_mode("ok");
        let temp = TestDir::new("repo-counts-argv");
        set_argv_log(&temp.join("argv.log"));
        let (_temp, gh) = stub_gh("repo-counts-gh", "ok");

        let counts = gh.repo_counts(&sample_repo()).await.unwrap();
        assert_eq!(counts.open_prs, Some(3));
        assert_eq!(counts.open_issues, Some(7));

        let log = argv_log(&temp);
        assert!(log.contains("api graphql -f query="), "argv = {log}");
        assert!(
            log.contains("pullRequests(states: OPEN) { totalCount }"),
            "argv = {log}"
        );
        assert!(
            log.contains("issues(states: OPEN) { totalCount }"),
            "argv = {log}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repo_counts_uses_hostname_only_for_enterprise_hosts() {
        let _lock = lock_env();
        set_mode("ok");

        // github.com：不该传 --hostname（gh 的默认值就是它，显式传只是噪音）。
        let temp = TestDir::new("repo-counts-hostname-com");
        set_argv_log(&temp.join("argv.log"));
        let (_temp, gh) = stub_gh("repo-counts-hostname-com-gh", "ok");
        gh.repo_counts(&sample_repo()).await.unwrap();
        let log = argv_log(&temp);
        assert!(!log.contains("--hostname"), "argv = {log}");

        // 企业主机：`gh api` 默认打 github.com，必须显式 --hostname，否则查错站。
        let temp = TestDir::new("repo-counts-hostname-ghe");
        set_argv_log(&temp.join("argv.log"));
        let (_temp, gh) = stub_gh("repo-counts-hostname-ghe-gh", "ok");
        let enterprise = RepoRef {
            host: Some("ghe.example.com".to_string()),
            owner: "acme".to_string(),
            name: "repo".to_string(),
        };
        gh.repo_counts(&enterprise).await.unwrap();
        let log = argv_log(&temp);
        assert!(
            log.contains("--hostname ghe.example.com"),
            "argv = {log}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn repo_counts_missing_data_maps_to_parse_failed() {
        let _lock = lock_env();
        let (_temp, gh) = stub_gh("counts-missing-data", "counts-missing-data");

        let error = gh.repo_counts(&sample_repo()).await.unwrap_err();
        assert!(matches!(
            error,
            GhError::ParseFailed { ref version } if version == "2.99.1"
        ));
        assert_eq!(error.code(), 50715);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn issue_release_run_workflow_and_tree_argv() {
        let _lock = lock_env();
        set_mode("ok");
        let temp = TestDir::new("dashboard-argv");
        set_argv_log(&temp.join("argv.log"));

        let issue_fixture = write_fixture(
            &temp,
            "issues.json",
            r#"[{"number":4,"title":"bug","state":"OPEN","author":{"login":"u","name":null,"is_bot":false},"labels":[{"name":"bug"}],"updatedAt":"2026-11-03T00:00:00Z","url":"https://example/4"}]"#,
        );
        set_fixture_path(&issue_fixture);
        let (_temp, gh) = stub_gh("issues-gh", "ok");
        let issues = gh
            .list_issues(&sample_repo(), IssueState::Open, 5)
            .await
            .unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].labels, vec!["bug"]);

        let release_fixture = write_fixture(
            &temp,
            "releases.json",
            r#"[{"tagName":"v1","name":"One","publishedAt":"2026-11-01T00:00:00Z","isLatest":true,"isDraft":false,"isPrerelease":false}]"#,
        );
        set_fixture_path(&release_fixture);
        let releases = gh.list_releases(&sample_repo(), 5).await.unwrap();
        assert_eq!(releases[0].tag_name, "v1");

        let run_fixture = write_fixture(
            &temp,
            "runs.json",
            r#"[{"databaseId":99,"displayTitle":"build","workflowName":"ci","status":"completed","conclusion":"success","headBranch":"main","event":"push","createdAt":"2026-11-03T00:00:00Z","url":"https://example/run/99"}]"#,
        );
        set_fixture_path(&run_fixture);
        let runs = gh.list_runs(&sample_repo(), 5).await.unwrap();
        assert_eq!(runs[0].id, 99);
        assert_eq!(runs[0].conclusion.as_deref(), Some("success"));

        let workflow_fixture = write_fixture(
            &temp,
            "workflows.json",
            r#"[{"id":7,"name":"ci","path":".github/workflows/ci.yml","state":"active"}]"#,
        );
        set_fixture_path(&workflow_fixture);
        let workflows = gh.list_workflows(&sample_repo()).await.unwrap();
        assert_eq!(workflows[0].id, 7);

        let tree_fixture = write_fixture(
            &temp,
            "tree.json",
            r#"{"entries":[{"name":"src","path":"src","size":0,"gitType":"tree"},{"name":"README.md","path":"README.md","size":12,"gitType":"blob"}]}"#,
        );
        set_fixture_path(&tree_fixture);
        let tree = gh.repo_tree(&sample_repo(), None, None).await.unwrap();
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].kind, TreeEntryKind::Dir);
        assert_eq!(tree[1].kind, TreeEntryKind::File);

        let log = argv_log(&temp);
        assert!(log.contains("issue list -R github.com/wangsyiiz/SinceArc --state open --limit 5 --json number,title,state,author,labels,updatedAt,url"), "argv = {log}");
        assert!(log.contains("release list -R github.com/wangsyiiz/SinceArc --limit 5 --json tagName,name,publishedAt,isLatest,isDraft,isPrerelease"), "argv = {log}");
        assert!(log.contains("run list -R github.com/wangsyiiz/SinceArc --limit 5 --json databaseId,displayTitle,workflowName,status,conclusion,headBranch,event,createdAt,url"), "argv = {log}");
        assert!(
            log.contains("workflow list -R github.com/wangsyiiz/SinceArc --json name,path,state,id"),
            "argv = {log}"
        );
        assert!(
            log.contains("repo read-dir -R github.com/wangsyiiz/SinceArc --json name,path,size,gitType"),
            "argv = {log}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn tree_with_path_and_ref_keeps_path_positional_and_repo_after_dash_r() {
        let _lock = lock_env();
        set_mode("ok");
        let temp = TestDir::new("tree-path-argv");
        let fixture = write_fixture(&temp, "tree.json", r#"{"entries":[]}"#);
        set_fixture_path(&fixture);
        set_argv_log(&temp.join("argv.log"));
        let (_temp, gh) = stub_gh("tree-path-gh", "ok");

        assert!(gh
            .repo_tree(&sample_repo(), Some("src"), Some("main"))
            .await
            .unwrap()
            .is_empty());

        let log = argv_log(&temp);
        assert!(log.contains("repo read-dir src -R github.com/wangsyiiz/SinceArc --ref main --json name,path,size,gitType"), "argv = {log}");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn my_open_prs_argv_and_mapping() {
        let _lock = lock_env();
        set_mode("ok");
        let temp = TestDir::new("my-prs-argv");
        let fixture = write_fixture(
            &temp,
            "my-prs.json",
            r#"[{"number":14914,"title":"fix: thing","repository":{"name":"cli","nameWithOwner":"cli/cli"},"url":"https://github.com/cli/cli/pull/14914","updatedAt":"2026-11-03T10:40:39Z","isDraft":false},{"number":7,"title":"draft: wip","repository":{"name":"web","nameWithOwner":"acme/web"},"url":"https://github.com/acme/web/pull/7","updatedAt":"2026-11-02T08:00:00Z","isDraft":true}]"#,
        );
        set_fixture_path(&fixture);
        set_argv_log(&temp.join("argv.log"));
        let (_temp, gh) = stub_gh("my-prs-gh", "ok");

        let items = gh.search_my_open_prs(100).await.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].number, 14914);
        assert_eq!(items[0].repo, "cli/cli");
        assert_eq!(items[0].updated_at, 1_793_702_439);
        assert!(!items[0].is_draft);
        assert!(items[1].is_draft);

        let log = argv_log(&temp);
        assert!(
            log.contains("search prs --author @me --state open --limit 100 --json number,title,repository,url,updatedAt,isDraft"),
            "argv = {log}"
        );
    }
}
