//! gh domain：状态与 PR 列表的 30 秒 TTL 缓存、列表排序；错误不进入缓存。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::model::{GhCli, GhError, GhStatus, PrState, PullRequest, RepoRef};

const STATUS_TTL: Duration = Duration::from_secs(30);
const LIST_TTL: Duration = Duration::from_secs(30);

type ListCacheKey = (String, String, String, PrState);

pub struct GhService {
    cli: Arc<dyn GhCli>,
    cache: Mutex<Option<(Instant, GhStatus)>>,
    list_cache: Mutex<HashMap<ListCacheKey, (Instant, Vec<PullRequest>)>>,
}

impl GhService {
    pub fn new(cli: Arc<dyn GhCli>) -> Self {
        Self {
            cli,
            cache: Mutex::new(None),
            list_cache: Mutex::new(HashMap::new()),
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
        list_calls: AtomicUsize,
        status_results: Mutex<VecDeque<Result<GhStatus, GhError>>>,
        list_results: Mutex<VecDeque<Result<Vec<PullRequest>, GhError>>>,
    }

    impl FakeGh {
        fn new(results: Vec<Result<GhStatus, GhError>>) -> Arc<Self> {
            Arc::new(Self {
                status_calls: AtomicUsize::new(0),
                list_calls: AtomicUsize::new(0),
                status_results: Mutex::new(results.into()),
                list_results: Mutex::new(VecDeque::new()),
            })
        }

        fn with_lists(results: Vec<Result<Vec<PullRequest>, GhError>>) -> Arc<Self> {
            Arc::new(Self {
                status_calls: AtomicUsize::new(0),
                list_calls: AtomicUsize::new(0),
                status_results: Mutex::new(VecDeque::new()),
                list_results: Mutex::new(results.into()),
            })
        }

        fn status_calls(&self) -> usize {
            self.status_calls.load(Ordering::SeqCst)
        }

        fn list_calls(&self) -> usize {
            self.list_calls.load(Ordering::SeqCst)
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
}
