//! 我的 open PR 后台轮询（docs/gh.md §13.2）。
//!
//! 这是唯一认识 `tauri::AppHandle` 的 gh 文件：adapter（cli.rs）只跑进程，
//! 结果由 `GhService` 的状态机缓存，再从这里推给前端。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::model::MyPrsState;
use super::service::GhService;
use super::MyPrsDto;

const FIRST_DELAY: Duration = Duration::from_secs(8);

/// 首轮等窗口起来（8s），之后按 `GhService::next_poll_interval()` 循环。
///
/// 取舍：`Unavailable`（没装 / 没登录）只记一条 info 就结束任务，不每 5 分钟刷失败日志。
/// 用户重新检测 / 登录后由前端调 `gh_my_prs(force)` 立刻恢复数据；watch 不会自启，
/// 本次会话余下时间也不会再自动轮询 —— 这是 §13.2 明确接受的代价。
///
/// `service` 必须与命令层是同一个实例（lib.rs 装配时传同一份 Arc），
/// 否则缓存与限流退避会各算一份。
pub fn spawn(app: AppHandle, service: Arc<GhService>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_DELAY).await;

        let busy = AtomicBool::new(false);
        loop {
            if busy.swap(true, Ordering::SeqCst) {
                // 理论上走不到（下面串行 await），保留它是为了明确「绝不叠加并发」。
                tokio::time::sleep(service.next_poll_interval()).await;
                continue;
            }

            let value = service.my_prs(true).await;
            busy.store(false, Ordering::SeqCst);

            let state = value.state;
            let count = value.items.len();
            let has_more = value.has_more;
            let stale = value.stale;
            let error_code = value.error.as_ref().map(|error| error.code());
            let dto = MyPrsDto::from(value);

            if let Err(error) = app.emit("gh:open-prs", dto) {
                tracing::warn!(
                    target: "sincearc::gh",
                    error = %error,
                    "could not emit gh:open-prs"
                );
            }

            if state == MyPrsState::Unavailable {
                tracing::info!(
                    target: "sincearc::gh",
                    "gh unavailable (not installed / not logged in); open PR polling stopped"
                );
                break;
            }

            if let Some(code) = error_code {
                tracing::warn!(
                    target: "sincearc::gh",
                    code,
                    stale,
                    "gh open PR refresh failed"
                );
            } else {
                tracing::info!(
                    target: "sincearc::gh",
                    count,
                    has_more,
                    "gh open PRs refreshed"
                );
            }

            tokio::time::sleep(service.next_poll_interval()).await;
        }
    });
}
