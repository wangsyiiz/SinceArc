//! gh 状态缓存：30 秒 TTL；错误不进入缓存。

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use super::model::{GhCli, GhError, GhStatus};

const STATUS_TTL: Duration = Duration::from_secs(30);

pub struct GhService {
    cli: Arc<dyn GhCli>,
    cache: Mutex<Option<(Instant, GhStatus)>>,
}

impl GhService {
    pub fn new(cli: Arc<dyn GhCli>) -> Self {
        Self {
            cli,
            cache: Mutex::new(None),
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
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;

    use super::*;

    struct FakeGh {
        calls: AtomicUsize,
        results: Mutex<VecDeque<Result<GhStatus, GhError>>>,
    }

    impl FakeGh {
        fn new(results: Vec<Result<GhStatus, GhError>>) -> Arc<Self> {
            Arc::new(Self {
                calls: AtomicUsize::new(0),
                results: Mutex::new(results.into()),
            })
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl GhCli for FakeGh {
        async fn status(&self) -> Result<GhStatus, GhError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut results = self.results.lock().unwrap();
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
        assert_eq!(fake.calls(), 1);
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
        assert_eq!(fake.calls(), 2);
    }

    #[tokio::test]
    async fn error_is_not_cached() {
        let expected = sample_status("2.99.1");
        let (fake, service) = service(vec![Err(GhError::Timeout), Ok(expected.clone())]);

        assert!(service.status(false).await.is_err());
        assert_eq!(service.status(false).await.unwrap(), expected);
        assert_eq!(fake.calls(), 2);
    }
}
