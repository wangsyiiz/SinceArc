//! gh domain：状态/列表/详情/diff 的 TTL 缓存、列表排序与 diff 切片；错误不进入缓存。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::model::{
    ActionResult, Capability, DiffPage, GhActionParams, GhCli, GhError, GhStatus, Issue,
    IssueState, MyPrs, MyPrsState, PrDetail, PrState, PullRequest, Release, RepoCounts,
    RepoListing, RepoMeta, RepoRef, RepoSummary, TreeEntry, Viewer, Workflow, WorkflowRun,
    MAX_REPO_LIST_LIMIT,
};

const STATUS_TTL: Duration = Duration::from_secs(30);
const LIST_TTL: Duration = Duration::from_secs(30);
const DETAIL_TTL: Duration = Duration::from_secs(5 * 60);
const DIFF_TTL: Duration = Duration::from_secs(5 * 60);
/// dashboard 的概要元数据；计数单独 30s（docs/gh.md §10.3，按任务口径）。
const REPO_META_TTL: Duration = Duration::from_secs(5 * 60);
const REPO_COUNTS_TTL: Duration = Duration::from_secs(30);
const WORKFLOW_LIST_TTL: Duration = Duration::from_secs(5 * 60);
const TREE_TTL: Duration = Duration::from_secs(30);
/// 仓库列表 60s；key 只含 owner（不含 limit），缓存永远存最大那份。
pub const GH_REPOS_TTL: Duration = Duration::from_secs(60);
pub const VIEWER_TTL: Duration = Duration::from_secs(3600);

/// 我的 open PR：一次 `gh search prs` 拉满 100 条；满额即 `has_more`（§13.1）。
pub const MY_PRS_LIMIT: u32 = 100;
/// 首屏读缓存；后台 watch 按 `next_poll_interval()` 自己刷新。
const MY_PRS_TTL: Duration = Duration::from_secs(300);
const MY_PRS_BASE_INTERVAL_SECS: u64 = 300;
const MY_PRS_MAX_INTERVAL_SECS: u64 = 1800;

pub const DEFAULT_PAGE_SIZE: u32 = 200;
pub const MAX_PAGE_SIZE: u32 = 200;
pub const DEFAULT_REPO_LIST_LIMIT: u32 = 30;

type ListCacheKey = (String, String, String, PrState);
type PrCacheKey = (String, String, String, u32);
type RepoKey = (String, String, String);
type IssueCacheKey = (RepoKey, IssueState, u32);
type ReleaseCacheKey = (RepoKey, u32);
type RunCacheKey = (RepoKey, u32);
type TreeCacheKey = (RepoKey, Option<String>, Option<String>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffPageError {
    BadPageSize(u32),
    Gh(GhError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoListPage {
    pub items: Vec<RepoListing>,
    pub has_more: bool,
}

pub struct GhService {
    cli: Arc<dyn GhCli>,
    cache: Mutex<Option<(Instant, GhStatus)>>,
    list_cache: Mutex<HashMap<ListCacheKey, (Instant, Vec<PullRequest>)>>,
    detail_cache: Mutex<HashMap<PrCacheKey, (Instant, PrDetail)>>,
    diff_cache: Mutex<HashMap<PrCacheKey, (Instant, String)>>,
    repo_cache: Mutex<HashMap<String, (Instant, Vec<RepoListing>)>>,
    viewer_cache: Mutex<Option<(Instant, Viewer)>>,
    meta_cache: Mutex<HashMap<RepoKey, (Instant, RepoMeta)>>,
    counts_cache: Mutex<HashMap<RepoKey, (Instant, RepoCounts)>>,
    issue_cache: Mutex<HashMap<IssueCacheKey, (Instant, Vec<Issue>)>>,
    release_cache: Mutex<HashMap<ReleaseCacheKey, (Instant, Vec<Release>)>>,
    run_cache: Mutex<HashMap<RunCacheKey, (Instant, Vec<WorkflowRun>)>>,
    workflow_cache: Mutex<HashMap<RepoKey, (Instant, Vec<Workflow>)>>,
    tree_cache: Mutex<HashMap<TreeCacheKey, (Instant, Vec<TreeEntry>)>>,
    my_prs_cache: Mutex<Option<(Instant, MyPrs)>>,
    /// 0 = 300s；每次限流 +1 档（×2），成功复位。
    my_prs_backoff: AtomicU32,
}

impl GhService {
    pub fn new(cli: Arc<dyn GhCli>) -> Self {
        Self {
            cli,
            cache: Mutex::new(None),
            list_cache: Mutex::new(HashMap::new()),
            detail_cache: Mutex::new(HashMap::new()),
            diff_cache: Mutex::new(HashMap::new()),
            repo_cache: Mutex::new(HashMap::new()),
            viewer_cache: Mutex::new(None),
            meta_cache: Mutex::new(HashMap::new()),
            counts_cache: Mutex::new(HashMap::new()),
            issue_cache: Mutex::new(HashMap::new()),
            release_cache: Mutex::new(HashMap::new()),
            run_cache: Mutex::new(HashMap::new()),
            workflow_cache: Mutex::new(HashMap::new()),
            tree_cache: Mutex::new(HashMap::new()),
            my_prs_cache: Mutex::new(None),
            my_prs_backoff: AtomicU32::new(0),
        }
    }

    pub async fn status(&self, force: bool) -> Result<GhStatus, GhError> {
        let mut cache = self.cache.lock().await;
        if !force {
            if let Some((at, status)) = cache.as_ref() {
                if at.elapsed() < STATUS_TTL {
                    return Ok(status.clone());
                }
            }
        }

        match self.cli.status().await {
            Ok(status) => {
                *cache = Some((Instant::now(), status.clone()));
                Ok(status)
            }
            Err(error) => {
                *cache = None;
                Err(error)
            }
        }
    }

    pub async fn viewer(&self, force: bool) -> Result<Viewer, GhError> {
        let mut cache = self.viewer_cache.lock().await;
        if !force {
            if let Some((at, viewer)) = cache.as_ref() {
                if at.elapsed() < VIEWER_TTL {
                    return Ok(viewer.clone());
                }
            }
        }

        match self.cli.viewer().await {
            Ok(viewer) => {
                *cache = Some((Instant::now(), viewer.clone()));
                Ok(viewer)
            }
            Err(error) => {
                *cache = None;
                Err(error)
            }
        }
    }

    /// 我的 open PR：缓存 + 状态机（docs/gh.md §13.2）。
    ///
    /// - 未 force 且缓存未过期：直接返回，不打 gh。
    /// - 没装 / 没登录：`Unavailable` + 空列表，不当作命令错误。
    /// - 限流：保留上一份 ready 数据（`stale=true`），并让下次轮询退避翻倍。
    /// - 其它错误：有上一份 ready 数据就返回旧数据（`stale=true` + error），否则 `Failed`。
    pub async fn my_prs(&self, force: bool) -> MyPrs {
        let mut cache = self.my_prs_cache.lock().await;
        if !force {
            if let Some((at, value)) = cache.as_ref() {
                if at.elapsed() < MY_PRS_TTL {
                    return value.clone();
                }
            }
        }

        let previous = cache.as_ref().map(|(_, value)| value.clone());
        match self.cli.search_my_open_prs(MY_PRS_LIMIT).await {
            Ok(mut items) => {
                items.sort_by_key(|pr| std::cmp::Reverse(pr.updated_at));
                let value = MyPrs {
                    state: MyPrsState::Ready,
                    has_more: items.len() as u32 == MY_PRS_LIMIT,
                    items,
                    stale: false,
                    updated_at: Some(now_epoch_secs()),
                    error: None,
                };
                self.my_prs_backoff.store(0, Ordering::SeqCst);
                *cache = Some((Instant::now(), value.clone()));
                value
            }
            Err(GhError::NotInstalled) | Err(GhError::NotLoggedIn) => {
                let value = MyPrs {
                    state: MyPrsState::Unavailable,
                    items: Vec::new(),
                    has_more: false,
                    stale: false,
                    updated_at: None,
                    error: None,
                };
                *cache = Some((Instant::now(), value.clone()));
                value
            }
            Err(error @ GhError::RateLimited { .. }) => {
                self.bump_my_prs_backoff();
                self.stale_or_failed(previous, error, &mut cache)
            }
            Err(error) => self.stale_or_failed(previous, error, &mut cache),
        }
    }

    /// watch 的下一轮间隔：300s 起，限流一次 ×2，上限 1800s；成功一次复位（§13.2）。
    pub fn next_poll_interval(&self) -> Duration {
        let level = self.my_prs_backoff.load(Ordering::SeqCst).min(3);
        let secs = MY_PRS_BASE_INTERVAL_SECS
            .saturating_mul(1u64 << level)
            .min(MY_PRS_MAX_INTERVAL_SECS);
        Duration::from_secs(secs)
    }

    fn bump_my_prs_backoff(&self) {
        let next = self
            .my_prs_backoff
            .load(Ordering::SeqCst)
            .saturating_add(1)
            .min(3);
        self.my_prs_backoff.store(next, Ordering::SeqCst);
    }

    fn stale_or_failed(
        &self,
        previous: Option<MyPrs>,
        error: GhError,
        cache: &mut Option<(Instant, MyPrs)>,
    ) -> MyPrs {
        if let Some(mut value) = previous.filter(|value| value.state == MyPrsState::Ready) {
            value.stale = true;
            value.error = Some(error);
            *cache = Some((Instant::now(), value.clone()));
            return value;
        }

        let value = MyPrs {
            state: MyPrsState::Failed,
            items: Vec::new(),
            has_more: false,
            stale: false,
            updated_at: None,
            error: Some(error),
        };
        *cache = Some((Instant::now(), value.clone()));
        value
    }

    pub async fn list_prs(
        &self,
        repo: &RepoRef,
        state: PrState,
        force: bool,
    ) -> Result<Vec<PullRequest>, GhError> {
        let key = (
            repo.host.clone().unwrap_or_default(),
            repo.owner.clone(),
            repo.name.clone(),
            state,
        );

        let mut cache = self.list_cache.lock().await;
        if !force {
            if let Some((at, items)) = cache.get(&key) {
                if at.elapsed() < LIST_TTL {
                    return Ok(items.clone());
                }
            }
        }

        match self.cli.list_prs(repo, state).await {
            Ok(mut items) => {
                // 列表里的 `updated_at` 一律是 `YYYY-MM-DDTHH:MM:SSZ`（UTC），
                // 这个格式的字典序就是时间序，直接字符串倒序即可。
                // 一旦出现带时区偏移（如 +08:00），字典序不再等于时间序，必须改为真解析。
                items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                cache.insert(key, (Instant::now(), items.clone()));
                Ok(items)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    /// 仓库列表：按 owner 缓存 60s，缓存的是 `MAX_REPO_LIST_LIMIT` 拉满的那份；
    /// 每次按调用方 limit 切片，`has_more` 用切片前的长度判断。
    pub async fn list_repos_page(
        &self,
        owner: Option<&str>,
        limit: u32,
        force: bool,
    ) -> Result<RepoListPage, GhError> {
        let limit = limit.clamp(1, MAX_REPO_LIST_LIMIT);
        let owner = owner.map(str::trim).filter(|owner| !owner.is_empty());
        let key = owner.unwrap_or("*").to_string();

        let mut cache = self.repo_cache.lock().await;
        if !force {
            if let Some((at, items)) = cache.get(&key) {
                if at.elapsed() < GH_REPOS_TTL {
                    return Ok(slice_repo_page(items, limit));
                }
            }
        }

        match self.cli.list_repos(owner, MAX_REPO_LIST_LIMIT).await {
            Ok(items) => {
                cache.insert(key, (Instant::now(), items.clone()));
                Ok(slice_repo_page(&items, limit))
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn pr_detail(
        &self,
        repo: &RepoRef,
        number: u32,
        force: bool,
    ) -> Result<PrDetail, GhError> {
        let key = pr_cache_key(repo, number);

        let mut cache = self.detail_cache.lock().await;
        if !force {
            if let Some((at, detail)) = cache.get(&key) {
                if at.elapsed() < DETAIL_TTL {
                    return Ok(detail.clone());
                }
            }
        }

        match self.cli.pr_detail(repo, number).await {
            Ok(detail) => {
                cache.insert(key, (Instant::now(), detail.clone()));
                Ok(detail)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn pr_diff_page(
        &self,
        repo: &RepoRef,
        number: u32,
        page: u32,
        page_size: Option<u32>,
        force: bool,
    ) -> Result<DiffPage, DiffPageError> {
        let page_size = page_size.unwrap_or(DEFAULT_PAGE_SIZE);
        if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
            return Err(DiffPageError::BadPageSize(page_size));
        }

        let raw = self
            .pr_diff_raw(repo, number, force)
            .await
            .map_err(DiffPageError::Gh)?;
        slice_diff(&raw, page, page_size).map_err(DiffPageError::BadPageSize)
    }

    async fn pr_diff_raw(
        &self,
        repo: &RepoRef,
        number: u32,
        force: bool,
    ) -> Result<String, GhError> {
        let key = pr_cache_key(repo, number);

        let mut cache = self.diff_cache.lock().await;
        if !force {
            if let Some((at, diff)) = cache.get(&key) {
                if at.elapsed() < DIFF_TTL {
                    return Ok(diff.clone());
                }
            }
        }

        match self.cli.pr_diff(repo, number).await {
            Ok(diff) => {
                cache.insert(key, (Instant::now(), diff.clone()));
                Ok(diff)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn repo_meta(&self, repo: &RepoRef, force: bool) -> Result<RepoMeta, GhError> {
        let key = repo_key(repo);

        let mut cache = self.meta_cache.lock().await;
        if !force {
            if let Some((at, meta)) = cache.get(&key) {
                if at.elapsed() < REPO_META_TTL {
                    return Ok(meta.clone());
                }
            }
        }

        match self.cli.repo_meta(repo).await {
            Ok(meta) => {
                cache.insert(key, (Instant::now(), meta.clone()));
                Ok(meta)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn repo_counts(&self, repo: &RepoRef, force: bool) -> Result<RepoCounts, GhError> {
        let key = repo_key(repo);

        let mut cache = self.counts_cache.lock().await;
        if !force {
            if let Some((at, counts)) = cache.get(&key) {
                if at.elapsed() < REPO_COUNTS_TTL {
                    return Ok(*counts);
                }
            }
        }

        match self.cli.repo_counts(repo).await {
            Ok(counts) => {
                cache.insert(key, (Instant::now(), counts));
                Ok(counts)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    /// 两块并发拿，各自独立降级；首屏 ≈ 最慢那个（§10.3）。
    pub async fn repo_summary(&self, repo: &RepoRef, force: bool) -> RepoSummary {
        let (meta, counts) =
            tokio::join!(self.repo_meta(repo, force), self.repo_counts(repo, force));
        RepoSummary { meta, counts }
    }

    pub async fn list_issues(
        &self,
        repo: &RepoRef,
        state: IssueState,
        limit: u32,
        force: bool,
    ) -> Result<Vec<Issue>, GhError> {
        let key = (repo_key(repo), state, limit);

        let mut cache = self.issue_cache.lock().await;
        if !force {
            if let Some((at, items)) = cache.get(&key) {
                if at.elapsed() < LIST_TTL {
                    return Ok(items.clone());
                }
            }
        }

        match self.cli.list_issues(repo, state, limit).await {
            Ok(items) => {
                cache.insert(key, (Instant::now(), items.clone()));
                Ok(items)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn list_releases(
        &self,
        repo: &RepoRef,
        limit: u32,
        force: bool,
    ) -> Result<Vec<Release>, GhError> {
        let key = (repo_key(repo), limit);

        let mut cache = self.release_cache.lock().await;
        if !force {
            if let Some((at, items)) = cache.get(&key) {
                if at.elapsed() < LIST_TTL {
                    return Ok(items.clone());
                }
            }
        }

        match self.cli.list_releases(repo, limit).await {
            Ok(items) => {
                cache.insert(key, (Instant::now(), items.clone()));
                Ok(items)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn list_runs(
        &self,
        repo: &RepoRef,
        limit: u32,
        force: bool,
    ) -> Result<Vec<WorkflowRun>, GhError> {
        let key = (repo_key(repo), limit);

        let mut cache = self.run_cache.lock().await;
        if !force {
            if let Some((at, items)) = cache.get(&key) {
                if at.elapsed() < LIST_TTL {
                    return Ok(items.clone());
                }
            }
        }

        match self.cli.list_runs(repo, limit).await {
            Ok(items) => {
                cache.insert(key, (Instant::now(), items.clone()));
                Ok(items)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn list_workflows(
        &self,
        repo: &RepoRef,
        force: bool,
    ) -> Result<Vec<Workflow>, GhError> {
        let key = repo_key(repo);

        let mut cache = self.workflow_cache.lock().await;
        if !force {
            if let Some((at, items)) = cache.get(&key) {
                if at.elapsed() < WORKFLOW_LIST_TTL {
                    return Ok(items.clone());
                }
            }
        }

        match self.cli.list_workflows(repo).await {
            Ok(items) => {
                cache.insert(key, (Instant::now(), items.clone()));
                Ok(items)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn repo_tree(
        &self,
        repo: &RepoRef,
        path: Option<&str>,
        git_ref: Option<&str>,
        force: bool,
    ) -> Result<Vec<TreeEntry>, GhError> {
        let path = path
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(str::to_string);
        let git_ref = git_ref
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let key = (repo_key(repo), path.clone(), git_ref.clone());

        let mut cache = self.tree_cache.lock().await;
        if !force {
            if let Some((at, items)) = cache.get(&key) {
                if at.elapsed() < TREE_TTL {
                    return Ok(items.clone());
                }
            }
        }

        match self
            .cli
            .repo_tree(repo, path.as_deref(), git_ref.as_deref())
            .await
        {
            Ok(items) => {
                cache.insert(key, (Instant::now(), items.clone()));
                Ok(items)
            }
            Err(error) => {
                cache.remove(&key);
                Err(error)
            }
        }
    }

    pub async fn capabilities(&self, repo: &RepoRef) -> Result<Vec<Capability>, GhError> {
        self.cli.capabilities(repo).await
    }

    pub async fn action(
        &self,
        repo: &RepoRef,
        params: &GhActionParams,
    ) -> Result<ActionResult, GhError> {
        self.cli.action(repo, params).await
    }
}

fn slice_repo_page(items: &[RepoListing], limit: u32) -> RepoListPage {
    let limit = limit.clamp(1, MAX_REPO_LIST_LIMIT) as usize;
    RepoListPage {
        items: items.iter().take(limit).cloned().collect(),
        has_more: items.len() >= limit,
    }
}

fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn pr_cache_key(repo: &RepoRef, number: u32) -> PrCacheKey {
    (
        repo.host.clone().unwrap_or_default(),
        repo.owner.clone(),
        repo.name.clone(),
        number,
    )
}

fn repo_key(repo: &RepoRef) -> RepoKey {
    (
        repo.host.clone().unwrap_or_default(),
        repo.owner.clone(),
        repo.name.clone(),
    )
}

/// 按 `\n` 切行；`\r\n` 先归一，末尾换行不产生多余的空页。
fn diff_lines(raw: &str) -> Vec<String> {
    let normalized = raw.replace("\r\n", "\n");
    if normalized.is_empty() {
        return Vec::new();
    }
    let normalized = normalized.strip_suffix('\n').unwrap_or(&normalized);
    normalized.split('\n').map(str::to_string).collect()
}

fn slice_diff(raw: &str, page: u32, page_size: u32) -> Result<DiffPage, u32> {
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(page_size);
    }
    let lines = diff_lines(raw);
    let total_lines = lines.len();
    let total_pages = total_lines.div_ceil(page_size as usize) as u32;
    let start = (page as usize).saturating_mul(page_size as usize);
    let page_lines = if start >= total_lines {
        Vec::new()
    } else {
        let end = (start + page_size as usize).min(total_lines);
        lines[start..end].to_vec()
    };

    Ok(DiffPage {
        lines: page_lines,
        page,
        page_size,
        total_lines,
        total_pages,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;

    use super::*;
    use crate::gh::model::{Author, CheckState, MyPullRequest, PrStateView};

    struct FakeGh {
        status_calls: AtomicUsize,
        viewer_calls: AtomicUsize,
        repo_calls: AtomicUsize,
        list_calls: AtomicUsize,
        detail_calls: AtomicUsize,
        diff_calls: AtomicUsize,
        meta_calls: AtomicUsize,
        counts_calls: AtomicUsize,
        issue_calls: AtomicUsize,
        release_calls: AtomicUsize,
        run_calls: AtomicUsize,
        workflow_calls: AtomicUsize,
        tree_calls: AtomicUsize,
        my_prs_calls: AtomicUsize,
        status_results: Mutex<VecDeque<Result<GhStatus, GhError>>>,
        viewer_results: Mutex<VecDeque<Result<Viewer, GhError>>>,
        repo_results: Mutex<VecDeque<Result<Vec<RepoListing>, GhError>>>,
        list_results: Mutex<VecDeque<Result<Vec<PullRequest>, GhError>>>,
        detail_results: Mutex<VecDeque<Result<PrDetail, GhError>>>,
        diff_results: Mutex<VecDeque<Result<String, GhError>>>,
        meta_results: Mutex<VecDeque<Result<RepoMeta, GhError>>>,
        counts_results: Mutex<VecDeque<Result<RepoCounts, GhError>>>,
        my_prs_results: Mutex<VecDeque<Result<Vec<MyPullRequest>, GhError>>>,
    }

    impl FakeGh {
        fn new(results: Vec<Result<GhStatus, GhError>>) -> Arc<Self> {
            Arc::new(Self {
                status_calls: AtomicUsize::new(0),
                viewer_calls: AtomicUsize::new(0),
                repo_calls: AtomicUsize::new(0),
                list_calls: AtomicUsize::new(0),
                detail_calls: AtomicUsize::new(0),
                diff_calls: AtomicUsize::new(0),
                meta_calls: AtomicUsize::new(0),
                counts_calls: AtomicUsize::new(0),
                issue_calls: AtomicUsize::new(0),
                release_calls: AtomicUsize::new(0),
                run_calls: AtomicUsize::new(0),
                workflow_calls: AtomicUsize::new(0),
                tree_calls: AtomicUsize::new(0),
                my_prs_calls: AtomicUsize::new(0),
                status_results: Mutex::new(results.into()),
                viewer_results: Mutex::new(VecDeque::new()),
                repo_results: Mutex::new(VecDeque::new()),
                list_results: Mutex::new(VecDeque::new()),
                detail_results: Mutex::new(VecDeque::new()),
                diff_results: Mutex::new(VecDeque::new()),
                meta_results: Mutex::new(VecDeque::new()),
                counts_results: Mutex::new(VecDeque::new()),
                my_prs_results: Mutex::new(VecDeque::new()),
            })
        }

        fn with_lists(results: Vec<Result<Vec<PullRequest>, GhError>>) -> Arc<Self> {
            Arc::new(Self {
                status_calls: AtomicUsize::new(0),
                viewer_calls: AtomicUsize::new(0),
                repo_calls: AtomicUsize::new(0),
                list_calls: AtomicUsize::new(0),
                detail_calls: AtomicUsize::new(0),
                diff_calls: AtomicUsize::new(0),
                meta_calls: AtomicUsize::new(0),
                counts_calls: AtomicUsize::new(0),
                issue_calls: AtomicUsize::new(0),
                release_calls: AtomicUsize::new(0),
                run_calls: AtomicUsize::new(0),
                workflow_calls: AtomicUsize::new(0),
                tree_calls: AtomicUsize::new(0),
                my_prs_calls: AtomicUsize::new(0),
                status_results: Mutex::new(VecDeque::new()),
                viewer_results: Mutex::new(VecDeque::new()),
                repo_results: Mutex::new(VecDeque::new()),
                list_results: Mutex::new(results.into()),
                detail_results: Mutex::new(VecDeque::new()),
                diff_results: Mutex::new(VecDeque::new()),
                meta_results: Mutex::new(VecDeque::new()),
                counts_results: Mutex::new(VecDeque::new()),
                my_prs_results: Mutex::new(VecDeque::new()),
            })
        }

        fn with_my_prs(results: Vec<Result<Vec<MyPullRequest>, GhError>>) -> Arc<Self> {
            let fake = Self::new(Vec::new());
            *fake.my_prs_results.lock().unwrap() = results.into();
            fake
        }

        fn with_details(results: Vec<Result<PrDetail, GhError>>) -> Arc<Self> {
            let fake = Self::new(Vec::new());
            *fake.detail_results.lock().unwrap() = results.into();
            fake
        }

        fn with_repos(results: Vec<Result<Vec<RepoListing>, GhError>>) -> Arc<Self> {
            let fake = Self::new(Vec::new());
            *fake.repo_results.lock().unwrap() = results.into();
            fake
        }

        fn with_diffs(results: Vec<Result<String, GhError>>) -> Arc<Self> {
            let fake = Self::new(Vec::new());
            *fake.diff_results.lock().unwrap() = results.into();
            fake
        }

        fn with_viewers(results: Vec<Result<Viewer, GhError>>) -> Arc<Self> {
            let fake = Self::new(Vec::new());
            *fake.viewer_results.lock().unwrap() = results.into();
            fake
        }

        fn with_summary(
            meta: Vec<Result<RepoMeta, GhError>>,
            counts: Vec<Result<RepoCounts, GhError>>,
        ) -> Arc<Self> {
            let fake = Self::new(Vec::new());
            *fake.meta_results.lock().unwrap() = meta.into();
            *fake.counts_results.lock().unwrap() = counts.into();
            fake
        }

        fn status_calls(&self) -> usize {
            self.status_calls.load(Ordering::SeqCst)
        }

        fn viewer_calls(&self) -> usize {
            self.viewer_calls.load(Ordering::SeqCst)
        }

        fn list_calls(&self) -> usize {
            self.list_calls.load(Ordering::SeqCst)
        }

        fn repo_calls(&self) -> usize {
            self.repo_calls.load(Ordering::SeqCst)
        }

        fn detail_calls(&self) -> usize {
            self.detail_calls.load(Ordering::SeqCst)
        }

        fn diff_calls(&self) -> usize {
            self.diff_calls.load(Ordering::SeqCst)
        }

        fn meta_calls(&self) -> usize {
            self.meta_calls.load(Ordering::SeqCst)
        }

        fn counts_calls(&self) -> usize {
            self.counts_calls.load(Ordering::SeqCst)
        }

        fn workflow_calls(&self) -> usize {
            self.workflow_calls.load(Ordering::SeqCst)
        }

        fn my_prs_calls(&self) -> usize {
            self.my_prs_calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl GhCli for FakeGh {
        async fn status(&self) -> Result<GhStatus, GhError> {
            self.status_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.status_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn viewer(&self) -> Result<Viewer, GhError> {
            self.viewer_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.viewer_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn search_my_open_prs(&self, _limit: u32) -> Result<Vec<MyPullRequest>, GhError> {
            self.my_prs_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.my_prs_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn list_repos(
            &self,
            _owner: Option<&str>,
            _limit: u32,
        ) -> Result<Vec<RepoListing>, GhError> {
            self.repo_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.repo_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn list_prs(
            &self,
            _repo: &RepoRef,
            _state: PrState,
        ) -> Result<Vec<PullRequest>, GhError> {
            self.list_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.list_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn pr_detail(&self, _repo: &RepoRef, _number: u32) -> Result<PrDetail, GhError> {
            self.detail_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.detail_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn pr_diff(&self, _repo: &RepoRef, _number: u32) -> Result<String, GhError> {
            self.diff_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.diff_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn repo_meta(&self, _repo: &RepoRef) -> Result<RepoMeta, GhError> {
            self.meta_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.meta_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn repo_counts(&self, _repo: &RepoRef) -> Result<RepoCounts, GhError> {
            self.counts_calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.counts_results.lock().unwrap();
            if results.len() > 1 {
                results.pop_front().unwrap()
            } else {
                results.front().cloned().unwrap()
            }
        }

        async fn list_issues(
            &self,
            _repo: &RepoRef,
            _state: IssueState,
            _limit: u32,
        ) -> Result<Vec<Issue>, GhError> {
            self.issue_calls.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }

        async fn list_releases(
            &self,
            _repo: &RepoRef,
            _limit: u32,
        ) -> Result<Vec<Release>, GhError> {
            self.release_calls.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }

        async fn list_runs(
            &self,
            _repo: &RepoRef,
            _limit: u32,
        ) -> Result<Vec<WorkflowRun>, GhError> {
            self.run_calls.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }

        async fn list_workflows(&self, _repo: &RepoRef) -> Result<Vec<Workflow>, GhError> {
            self.workflow_calls.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }

        async fn repo_tree(
            &self,
            _repo: &RepoRef,
            _path: Option<&str>,
            _git_ref: Option<&str>,
        ) -> Result<Vec<TreeEntry>, GhError> {
            self.tree_calls.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }

        async fn capabilities(&self, _repo: &RepoRef) -> Result<Vec<Capability>, GhError> {
            Ok(Vec::new())
        }

        async fn action(
            &self,
            _repo: &RepoRef,
            params: &GhActionParams,
        ) -> Result<ActionResult, GhError> {
            Err(GhError::ActionDenied {
                action: params.action(),
                reason: crate::gh::model::DenyReason::Readonly,
            })
        }
    }

    fn sample_status(version: &str) -> GhStatus {
        GhStatus {
            available: true,
            version: Some(version.to_string()),
            logged_in: true,
            gh_path: Some(format!(r"C:\fake\gh-{version}.exe")),
            host: Some("github.com".to_string()),
            cwd_ok: true,
        }
    }

    fn service(results: Vec<Result<GhStatus, GhError>>) -> (Arc<FakeGh>, GhService) {
        let fake = FakeGh::new(results);
        let service = GhService::new(fake.clone());
        (fake, service)
    }

    #[tokio::test]
    async fn cache_hits_within_ttl() {
        let expected = sample_status("2.99.1");
        let (fake, service) = service(vec![Ok(expected.clone())]);

        assert_eq!(service.status(false).await.unwrap(), expected);
        assert_eq!(service.status(false).await.unwrap(), expected);
        assert_eq!(fake.status_calls(), 1);
    }

    #[tokio::test]
    async fn force_bypasses_cache() {
        let first = sample_status("2.99.1");
        let second = sample_status("2.99.2");
        let (fake, service) = service(vec![Ok(first), Ok(second.clone())]);

        assert_eq!(
            service.status(false).await.unwrap().version.as_deref(),
            Some("2.99.1")
        );
        assert_eq!(service.status(true).await.unwrap(), second);
        assert_eq!(fake.status_calls(), 2);
    }

    #[tokio::test]
    async fn error_is_not_cached() {
        let expected = sample_status("2.99.1");
        let (fake, service) = service(vec![Err(GhError::Timeout), Ok(expected.clone())]);

        assert!(service.status(false).await.is_err());
        assert_eq!(service.status(false).await.unwrap(), expected);
        assert_eq!(fake.status_calls(), 2);
    }

    #[tokio::test]
    async fn viewer_cache_hits_within_ttl_and_force_bypasses() {
        let first = Viewer {
            login: "wangsyiiz".to_string(),
            name: Some("X".to_string()),
            avatar_url: Some("https://example.com/a.png".to_string()),
        };
        let second = Viewer {
            login: "other".to_string(),
            name: None,
            avatar_url: None,
        };
        let fake = FakeGh::with_viewers(vec![Ok(first.clone()), Ok(second.clone())]);
        let service = GhService::new(fake.clone());

        assert_eq!(service.viewer(false).await.unwrap(), first);
        assert_eq!(service.viewer(false).await.unwrap(), first);
        assert_eq!(fake.viewer_calls(), 1, "TTL 内不应重复调用 gh");

        assert_eq!(service.viewer(true).await.unwrap(), second);
        assert_eq!(fake.viewer_calls(), 2);
    }

    fn sample_pr(number: u32, updated_at: &str) -> PullRequest {
        PullRequest {
            number,
            title: format!("PR {number}"),
            url: format!("https://github.com/acme/repo/pull/{number}"),
            state: PrStateView::Open,
            author: Author {
                login: "tester".to_string(),
                name: None,
                is_bot: false,
            },
            head: "feature".to_string(),
            base: "main".to_string(),
            updated_at: updated_at.to_string(),
            mergeable: None,
            review_decision: None,
            checks: CheckState::Passing,
        }
    }

    fn sample_repo_listing(index: u32) -> RepoListing {
        RepoListing {
            repo: RepoRef {
                host: Some("github.com".to_string()),
                owner: "acme".to_string(),
                name: format!("repo-{index}"),
            },
            default_branch: Some("main".to_string()),
            is_private: (index & 1) == 0,
            updated_at: Some(1_790_000_000 + i64::from(index)),
            description: None,
        }
    }

    fn repo() -> RepoRef {
        RepoRef {
            host: Some("github.com".to_string()),
            owner: "acme".to_string(),
            name: "repo".to_string(),
        }
    }

    #[tokio::test]
    async fn list_sorted_by_updated_at_desc() {
        // 故意乱序：字符串字典序在 gh 的 `YYYY-MM-DDTHH:MM:SSZ` 上等于时间序。
        let unsorted = vec![
            sample_pr(1, "2026-10-28T08:00:00Z"),
            sample_pr(3, "2026-10-28T10:00:00Z"),
            sample_pr(2, "2026-10-28T09:00:00Z"),
        ];
        let fake = FakeGh::with_lists(vec![Ok(unsorted)]);
        let service = GhService::new(fake);

        let items = service
            .list_prs(&repo(), PrState::Open, false)
            .await
            .unwrap();
        let numbers: Vec<u32> = items.iter().map(|pr| pr.number).collect();
        assert_eq!(numbers, vec![3, 2, 1]);
    }

    #[tokio::test]
    async fn list_cache_hits_within_ttl() {
        let fake = FakeGh::with_lists(vec![Ok(vec![sample_pr(1, "2026-10-28T08:00:00Z")])]);
        let service = GhService::new(fake.clone());

        service
            .list_prs(&repo(), PrState::Open, false)
            .await
            .unwrap();
        service
            .list_prs(&repo(), PrState::Open, false)
            .await
            .unwrap();
        assert_eq!(fake.list_calls(), 1);
    }

    #[tokio::test]
    async fn list_force_bypasses_cache() {
        let fake = FakeGh::with_lists(vec![
            Ok(vec![sample_pr(1, "2026-10-28T08:00:00Z")]),
            Ok(vec![sample_pr(2, "2026-10-28T09:00:00Z")]),
        ]);
        let service = GhService::new(fake.clone());

        let first = service
            .list_prs(&repo(), PrState::Open, false)
            .await
            .unwrap();
        let second = service
            .list_prs(&repo(), PrState::Open, true)
            .await
            .unwrap();
        assert_eq!(first[0].number, 1);
        assert_eq!(second[0].number, 2);
        assert_eq!(fake.list_calls(), 2);
    }

    #[tokio::test]
    async fn list_error_is_not_cached() {
        let expected = vec![sample_pr(1, "2026-10-28T08:00:00Z")];
        let fake = FakeGh::with_lists(vec![Err(GhError::Timeout), Ok(expected.clone())]);
        let service = GhService::new(fake.clone());

        assert!(service
            .list_prs(&repo(), PrState::Open, false)
            .await
            .is_err());
        assert_eq!(
            service
                .list_prs(&repo(), PrState::Open, false)
                .await
                .unwrap(),
            expected
        );
        assert_eq!(fake.list_calls(), 2);
    }

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("gh")
                .join(name),
        )
        .unwrap()
    }

    fn diff_fixture() -> String {
        fixture("pr-diff.txt")
    }

    #[tokio::test]
    async fn slice_first_page_200() {
        let fake = FakeGh::with_diffs(vec![Ok(diff_fixture())]);
        let service = GhService::new(fake);

        let page = service
            .pr_diff_page(&repo(), 12, 0, Some(200), false)
            .await
            .unwrap();
        assert_eq!(page.lines.len(), 200);
        assert_eq!(page.page, 0);
        assert_eq!(page.page_size, 200);
        assert_eq!(page.total_lines, 974);
        assert_eq!(page.total_pages, 5);
        assert_eq!(
            page.lines[0],
            "diff --git a/.gitattributes b/.gitattributes"
        );
    }

    #[tokio::test]
    async fn slice_last_page_174() {
        let fake = FakeGh::with_diffs(vec![Ok(diff_fixture())]);
        let service = GhService::new(fake);

        let page = service
            .pr_diff_page(&repo(), 12, 4, Some(200), false)
            .await
            .unwrap();
        assert_eq!(page.lines.len(), 174);
        assert_eq!(page.total_pages, 5);
    }

    #[tokio::test]
    async fn slice_out_of_range_is_empty_not_error() {
        let fake = FakeGh::with_diffs(vec![Ok(diff_fixture())]);
        let service = GhService::new(fake);

        let page = service
            .pr_diff_page(&repo(), 12, 5, Some(200), false)
            .await
            .unwrap();
        assert!(page.lines.is_empty());
        assert_eq!(page.total_lines, 974);
        assert_eq!(page.total_pages, 5);
    }

    #[tokio::test]
    async fn slice_rejects_page_size_out_of_range() {
        let fake = FakeGh::with_diffs(vec![Ok(diff_fixture())]);
        let service = GhService::new(fake.clone());

        for size in [0, 201] {
            let error = service
                .pr_diff_page(&repo(), 12, 0, Some(size), false)
                .await
                .unwrap_err();
            assert_eq!(error, DiffPageError::BadPageSize(size));
        }
        assert_eq!(fake.diff_calls(), 0);
    }

    #[tokio::test]
    async fn slice_normalizes_crlf() {
        let lf = diff_fixture();
        let lf = if lf.ends_with('\n') {
            lf
        } else {
            format!("{lf}\n")
        };
        let crlf = lf.replace("\r\n", "\n").replace('\n', "\r\n");
        assert!(crlf.contains("\r\n"));
        let fake = FakeGh::with_diffs(vec![Ok(crlf)]);
        let service = GhService::new(fake);

        let page = service
            .pr_diff_page(&repo(), 12, 0, Some(200), false)
            .await
            .unwrap();
        assert_eq!(page.total_lines, 974);
        assert_eq!(page.total_pages, 5);
        assert_eq!(page.lines.len(), 200);
        assert_eq!(page.lines, diff_lines(&lf)[..200].to_vec());
        assert!(page.lines.iter().all(|line| !line.contains('\r')));
    }

    #[tokio::test]
    async fn slice_trailing_newline_does_not_add_a_page() {
        let raw = (0..974)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let page = slice_diff(&raw, 4, 200).unwrap();
        assert_eq!(page.total_lines, 974);
        assert_eq!(page.total_pages, 5);
        assert_eq!(page.lines.len(), 174);
    }

    fn sample_detail(title: &str) -> PrDetail {
        PrDetail {
            pr: sample_pr(12, "2026-10-28T10:03:06Z"),
            body: title.to_string(),
            created_at: "2026-10-28T10:00:28Z".to_string(),
            additions: 803,
            deletions: 3,
            changed_files: 13,
            files: Vec::new(),
            files_truncated: false,
        }
    }

    #[tokio::test]
    async fn detail_cache_hits_and_force_and_error_not_cached() {
        let first = sample_detail("first");
        let second = sample_detail("second");
        let fake = FakeGh::with_details(vec![
            Ok(first.clone()),
            Err(GhError::PrNotFound),
            Ok(second.clone()),
        ]);
        let service = GhService::new(fake.clone());

        assert_eq!(service.pr_detail(&repo(), 12, false).await.unwrap(), first);
        assert_eq!(service.pr_detail(&repo(), 12, false).await.unwrap(), first);
        assert_eq!(fake.detail_calls(), 1);

        assert_eq!(
            service.pr_detail(&repo(), 12, true).await.unwrap_err(),
            GhError::PrNotFound
        );
        assert_eq!(fake.detail_calls(), 2);

        assert_eq!(service.pr_detail(&repo(), 12, false).await.unwrap(), second);
        assert_eq!(fake.detail_calls(), 3);
    }

    #[tokio::test]
    async fn diff_cache_hits_and_force() {
        let fake = FakeGh::with_diffs(vec![Ok(diff_fixture()), Ok("second\n".to_string())]);
        let service = GhService::new(fake.clone());

        let first = service
            .pr_diff_page(&repo(), 12, 0, Some(200), false)
            .await
            .unwrap();
        let cached = service
            .pr_diff_page(&repo(), 12, 0, Some(200), false)
            .await
            .unwrap();
        assert_eq!(first, cached);
        assert_eq!(fake.diff_calls(), 1);

        let forced = service
            .pr_diff_page(&repo(), 12, 0, Some(200), true)
            .await
            .unwrap();
        assert_eq!(forced.total_lines, 1);
        assert_eq!(fake.diff_calls(), 2);
    }

    #[tokio::test]
    async fn repo_list_cache_ignores_limit_and_slices_with_has_more() {
        let items: Vec<RepoListing> = (0..5).map(sample_repo_listing).collect();
        let fake = FakeGh::with_repos(vec![Ok(items.clone())]);
        let service = GhService::new(fake.clone());

        let first = service.list_repos_page(None, 2, false).await.unwrap();
        assert_eq!(first.items, items[..2].to_vec());
        assert!(first.has_more, "切片前有 5 条，limit=2 必须还有更多");
        assert_eq!(fake.repo_calls(), 1);

        let second = service.list_repos_page(None, 5, false).await.unwrap();
        assert_eq!(second.items, items);
        assert!(second.has_more, "切片前长度 == limit 时按契约仍算 has_more");
        assert_eq!(
            fake.repo_calls(),
            1,
            "缓存 key 不含 limit，第二次不应再调 gh"
        );

        let third = service.list_repos_page(None, 6, false).await.unwrap();
        assert_eq!(third.items, items);
        assert!(!third.has_more, "limit 大于总量时没有更多");
        assert_eq!(fake.repo_calls(), 1);
    }

    #[tokio::test]
    async fn repo_list_force_bypasses_cache_and_owner_has_its_own_key() {
        let first: Vec<RepoListing> = (0..2).map(sample_repo_listing).collect();
        let second: Vec<RepoListing> = (10..12).map(sample_repo_listing).collect();
        let third: Vec<RepoListing> = vec![sample_repo_listing(20)];
        let fake = FakeGh::with_repos(vec![
            Ok(first.clone()),
            Ok(second.clone()),
            Ok(third.clone()),
        ]);
        let service = GhService::new(fake.clone());

        assert_eq!(
            service.list_repos_page(None, 2, false).await.unwrap().items,
            first
        );
        assert_eq!(
            service
                .list_repos_page(Some("acme"), 2, false)
                .await
                .unwrap()
                .items,
            second
        );
        assert_eq!(
            service.list_repos_page(None, 2, true).await.unwrap().items,
            third
        );
        assert_eq!(fake.repo_calls(), 3);
    }

    #[tokio::test]
    async fn repo_list_error_is_not_cached() {
        let expected: Vec<RepoListing> = (0..2).map(sample_repo_listing).collect();
        let fake = FakeGh::with_repos(vec![Err(GhError::Timeout), Ok(expected.clone())]);
        let service = GhService::new(fake.clone());

        assert_eq!(
            service.list_repos_page(None, 2, false).await.unwrap_err(),
            GhError::Timeout
        );
        assert_eq!(
            service.list_repos_page(None, 2, false).await.unwrap().items,
            expected
        );
        assert_eq!(fake.repo_calls(), 2);
    }

    fn sample_meta(name: &str) -> RepoMeta {
        RepoMeta {
            name_with_owner: format!("acme/{name}"),
            description: Some("demo".to_string()),
            visibility: "PUBLIC".to_string(),
            default_branch: "main".to_string(),
            topics: vec!["rust".to_string()],
            pushed_at: "2026-11-03T00:00:00Z".to_string(),
            stargazers: 10,
            forks: 2,
            is_archived: false,
            has_issues: true,
            latest_release: None,
        }
    }

    fn sample_counts(open_prs: u32, open_issues: u32) -> RepoCounts {
        RepoCounts {
            open_prs: Some(open_prs),
            open_issues: Some(open_issues),
        }
    }

    #[tokio::test]
    async fn summary_degrades_meta_and_counts_independently() {
        let fake = FakeGh::with_summary(vec![Ok(sample_meta("repo"))], vec![Err(GhError::Timeout)]);
        let service = GhService::new(fake);

        let summary = service.repo_summary(&repo(), false).await;
        assert_eq!(summary.meta.as_ref().unwrap().name_with_owner, "acme/repo");
        assert_eq!(summary.counts.as_ref().unwrap_err(), &GhError::Timeout);
    }

    #[tokio::test]
    async fn summary_keeps_counts_when_meta_fails() {
        let fake = FakeGh::with_summary(
            vec![Err(GhError::RepoUnavailable)],
            vec![Ok(sample_counts(1, 2))],
        );
        let service = GhService::new(fake);

        let summary = service.repo_summary(&repo(), false).await;
        assert_eq!(
            summary.meta.as_ref().unwrap_err(),
            &GhError::RepoUnavailable
        );
        assert_eq!(summary.counts.as_ref().unwrap().open_prs, Some(1));
    }

    #[tokio::test]
    async fn meta_and_counts_cache_hit_and_expire_independently() {
        let fake = FakeGh::with_summary(
            vec![Ok(sample_meta("repo")), Ok(sample_meta("repo"))],
            vec![Ok(sample_counts(1, 2)), Ok(sample_counts(3, 4))],
        );
        let service = GhService::new(fake.clone());

        let first = service.repo_summary(&repo(), false).await;
        assert_eq!(first.counts.unwrap().open_prs, Some(1));
        assert_eq!(fake.meta_calls(), 1);
        assert_eq!(fake.counts_calls(), 1);

        // TTL 内再取一次：两块都不应重新调 gh。
        let second = service.repo_summary(&repo(), false).await;
        assert_eq!(second.counts.unwrap().open_prs, Some(1));
        assert_eq!(fake.meta_calls(), 1);
        assert_eq!(fake.counts_calls(), 1);

        // 人为把 counts 缓存拨到 31s 前：counts 过期、meta 仍命中（5min）。
        {
            let mut cache = service.counts_cache.lock().await;
            for (at, _) in cache.values_mut() {
                *at = Instant::now() - Duration::from_secs(31);
            }
        }
        let third = service.repo_summary(&repo(), false).await;
        assert_eq!(third.counts.unwrap().open_prs, Some(3));
        assert_eq!(fake.meta_calls(), 1);
        assert_eq!(fake.counts_calls(), 2);

        // 再把 meta 拨到 5min 前：meta 也过期。
        {
            let mut cache = service.meta_cache.lock().await;
            for (at, _) in cache.values_mut() {
                *at = Instant::now() - Duration::from_secs(301);
            }
        }
        let fourth = service.repo_summary(&repo(), false).await;
        assert!(fourth.meta.is_ok());
        assert_eq!(fake.meta_calls(), 2);
    }

    #[tokio::test]
    async fn workflows_cache_hits_and_force_bypasses() {
        let fake = FakeGh::new(Vec::new());
        let service = GhService::new(fake.clone());

        service.list_workflows(&repo(), false).await.unwrap();
        service.list_workflows(&repo(), false).await.unwrap();
        assert_eq!(fake.workflow_calls(), 1);

        service.list_workflows(&repo(), true).await.unwrap();
        assert_eq!(fake.workflow_calls(), 2);
    }

    fn sample_my_pr(number: u32, updated_at: i64) -> MyPullRequest {
        MyPullRequest {
            number,
            title: format!("PR {number}"),
            url: format!("https://github.com/acme/repo/pull/{number}"),
            updated_at,
            is_draft: false,
            repo: "acme/repo".to_string(),
        }
    }

    #[tokio::test]
    async fn my_prs_cache_hits_within_ttl_and_force_bypasses() {
        let fake = FakeGh::with_my_prs(vec![
            Ok(vec![sample_my_pr(1, 10)]),
            Ok(vec![sample_my_pr(2, 20)]),
        ]);
        let service = GhService::new(fake.clone());

        let first = service.my_prs(false).await;
        assert_eq!(first.state, MyPrsState::Ready);
        assert_eq!(first.items[0].number, 1);
        let cached = service.my_prs(false).await;
        assert_eq!(cached.items[0].number, 1);
        assert_eq!(fake.my_prs_calls(), 1, "TTL 内不应再次调用 gh");

        let forced = service.my_prs(true).await;
        assert_eq!(forced.items[0].number, 2);
        assert_eq!(fake.my_prs_calls(), 2);
    }

    #[tokio::test]
    async fn my_prs_unavailable_is_not_an_error() {
        let fake = FakeGh::with_my_prs(vec![Err(GhError::NotLoggedIn)]);
        let service = GhService::new(fake.clone());

        let value = service.my_prs(false).await;
        assert_eq!(value.state, MyPrsState::Unavailable);
        assert!(value.items.is_empty());
        assert!(value.error.is_none());
        assert!(!value.has_more);
        assert!(!value.stale);

        let cached = service.my_prs(false).await;
        assert_eq!(cached.state, MyPrsState::Unavailable);
        assert_eq!(fake.my_prs_calls(), 1);
    }

    #[tokio::test]
    async fn my_prs_rate_limit_doubles_backoff_and_success_resets() {
        let fake = FakeGh::with_my_prs(vec![
            Ok(vec![sample_my_pr(1, 10)]),
            Err(GhError::RateLimited {
                reset: "42 minutes".to_string(),
            }),
            Err(GhError::RateLimited {
                reset: "42 minutes".to_string(),
            }),
            Err(GhError::RateLimited {
                reset: "42 minutes".to_string(),
            }),
            Ok(vec![sample_my_pr(2, 20)]),
        ]);
        let service = GhService::new(fake.clone());

        assert_eq!(service.next_poll_interval(), Duration::from_secs(300));
        service.my_prs(true).await;

        let limited = service.my_prs(true).await;
        assert!(limited.stale);
        assert_eq!(limited.items[0].number, 1, "限流必须保留上一份数据");
        assert!(matches!(limited.error, Some(GhError::RateLimited { .. })));
        assert_eq!(service.next_poll_interval(), Duration::from_secs(600));

        // 再连续限流两次：1200 → 1800（封顶）。
        service.my_prs(true).await;
        assert_eq!(service.next_poll_interval(), Duration::from_secs(1200));
        service.my_prs(true).await;
        assert_eq!(service.next_poll_interval(), Duration::from_secs(1800));

        // 成功一次立即复位。
        let ready = service.my_prs(true).await;
        assert_eq!(ready.state, MyPrsState::Ready);
        assert!(!ready.stale);
        assert_eq!(service.next_poll_interval(), Duration::from_secs(300));
    }

    #[tokio::test]
    async fn my_prs_other_error_keeps_previous_data_when_stale() {
        let first = vec![sample_my_pr(1, 10)];
        let fake = FakeGh::with_my_prs(vec![Ok(first.clone()), Err(GhError::Timeout)]);
        let service = GhService::new(fake.clone());

        let ready = service.my_prs(true).await;
        let updated_at = ready.updated_at;
        assert_eq!(ready.state, MyPrsState::Ready);

        let stale = service.my_prs(true).await;
        assert_eq!(stale.state, MyPrsState::Ready);
        assert_eq!(stale.items, first);
        assert!(stale.stale);
        assert_eq!(stale.updated_at, updated_at);
        assert_eq!(stale.error, Some(GhError::Timeout));
    }

    #[tokio::test]
    async fn my_prs_has_more_when_limit_is_full() {
        let items: Vec<MyPullRequest> = (0..100).map(|i| sample_my_pr(i, i as i64)).collect();
        let fake = FakeGh::with_my_prs(vec![Ok(items)]);
        let service = GhService::new(fake);

        let value = service.my_prs(false).await;
        assert!(value.has_more);
        assert_eq!(value.items.len(), 100);
        assert_eq!(value.items[0].number, 99, "按 updated_at 倒序");
    }
}
