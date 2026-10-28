//! gh adapter：唯一与进程、argv、超时和原始输出打交道的地方。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::model::{GhCli, GhError, GhStatus};

const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const AUTH_TIMEOUT: Duration = Duration::from_secs(5);

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

    async fn run(
        &self,
        path: &Path,
        args: &[&str],
        limit: Duration,
    ) -> Result<RunOutput, GhError> {
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
            });
        };

        let auth_output = self
            .run(&path, &["auth", "status"], AUTH_TIMEOUT)
            .await?;
        let logged_in = auth_output.status.success();
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
        })
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
        roots.extend(
            std::env::split_paths(&path).filter(|root| !root.as_os_str().is_empty()),
        );
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
}
