//! gh domain：状态/列表/详情/diff 的 TTL 缓存、列表排序与 diff 切片；错误不进入缓存。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::model::{
    DiffPage, GhCli, GhError, GhStatus, PrDetail, PrState, PullRequest, RepoListing, RepoRef,
    Viewer, MAX_REPO_LIST_LIMIT,
};

const STATUS_TTL: Duration = Duration::from_secs(30);
const LIST_TTL: Duration = Duration::from_secs(30);
const DETAIL_TTL: Duration = Duration::from_secs(5 * 60);
const DIFF_TTL: Duration = Duration::from_secs(5 * 60);
/// 仓库列表 60s；key 只含 owner（不含 limit），缓存永远存最大那份。
pub const GH_REPOS_TTL: Duration = Duration::from_secs(60);
pub const VIEWER_TTL: Duration = Duration::from_secs(3600);

pub const DEFAULT_PAGE_SIZE: u32 = 200;
pub const MAX_PAGE_SIZE: u32 = 200;
pub const DEFAULT_REPO_LIST_LIMIT: u32 = 30;

type ListCacheKey = (String, String, String, PrState);
type PrCacheKey = (String, String, String, u32);

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
}

fn slice_repo_page(items: &[RepoListing], limit: u32) -> RepoListPage {
    let limit = limit.clamp(1, MAX_REPO_LIST_LIMIT) as usize;
    RepoListPage {
        items: items.iter().take(limit).cloned().collect(),
        has_more: items.len() >= limit,
    }
}

fn pr_cache_key(repo: &RepoRef, number: u32) -> PrCacheKey {
    (
        repo.host.clone().unwrap_or_default(),
        repo.owner.clone(),
        repo.name.clone(),
        number,
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
    use crate::gh::model::{Author, CheckState, PrStateView};

    struct FakeGh {
        status_calls: AtomicUsize,
        viewer_calls: AtomicUsize,
        repo_calls: AtomicUsize,
        list_calls: AtomicUsize,
        detail_calls: AtomicUsize,
        diff_calls: AtomicUsize,
        status_results: Mutex<VecDeque<Result<GhStatus, GhError>>>,
        viewer_results: Mutex<VecDeque<Result<Viewer, GhError>>>,
        repo_results: Mutex<VecDeque<Result<Vec<RepoListing>, GhError>>>,
        list_results: Mutex<VecDeque<Result<Vec<PullRequest>, GhError>>>,
        detail_results: Mutex<VecDeque<Result<PrDetail, GhError>>>,
        diff_results: Mutex<VecDeque<Result<String, GhError>>>,
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
                status_results: Mutex::new(results.into()),
                viewer_results: Mutex::new(VecDeque::new()),
                repo_results: Mutex::new(VecDeque::new()),
                list_results: Mutex::new(VecDeque::new()),
                detail_results: Mutex::new(VecDeque::new()),
                diff_results: Mutex::new(VecDeque::new()),
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
                status_results: Mutex::new(VecDeque::new()),
                viewer_results: Mutex::new(VecDeque::new()),
                repo_results: Mutex::new(VecDeque::new()),
                list_results: Mutex::new(results.into()),
                detail_results: Mutex::new(VecDeque::new()),
                diff_results: Mutex::new(VecDeque::new()),
            })
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
            is_private: index % 2 == 0,
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
        assert!(
            second.has_more,
            "切片前长度 == limit 时按契约仍算 has_more"
        );
        assert_eq!(fake.repo_calls(), 1, "缓存 key 不含 limit，第二次不应再调 gh");

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
}
