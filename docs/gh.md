# GH 可视化：只读，gh CLI 客户端

> 决策（2026-10-27，所有者）：**只做 A —— 明确是 GH CLI 客户端**，shell out 到 `gh`，
> 不调 GitHub REST/GraphQL API、不在客户端持有 token。写操作（评论 / 建 PR / 合并）不做。
> 依据：只读 spike `001-gh-json-path`（读数列在末尾）。

## 1. 三层

```
src-tauri/src/gh/
├── cli.rs     探测可执行 + 执行 + 超时 + 错误映射（唯一与进程打交道的地方）
├── model.rs   领域模型（与 gh 的 JSON 形状解耦）
└── mod.rs     命令层对外：gh_status / gh_pr_list / gh_pr_detail
```

- **adapter（cli.rs）**：先探测可执行文件，再执行；每次调用都有超时；stderr 映射成错误码。
- **domain**：`gh` 的 JSON → 自家模型；列表 TTL 30s、详情 TTL 5min；排序在后端给出（更新时间倒序）。
- **命令层**：按「资源 + 动作」命名，不为单个界面造专用命令。前端只渲染与翻页。

**门禁边界（硬约束）**

- **不引新依赖（白名单唯一例外：`async-trait`）**：`GhCli` 必须同时「异步」且「dyn-safe」
  （`Arc<dyn GhCli>` 要能进 `AppState`），原生 `async fn` in trait 不满足 dyn，故用 `async-trait`
  （proc-macro，不进二进制；其三个传递依赖 `proc-macro2` / `quote` / `syn` 本已在锁文件里）。
  **白名单之外一律拒绝**：不引 octocrab / reqwest / 任何 HTTP 客户端。
- 进程与超时用 `tokio::process` + `tokio::time::timeout`（两者都已在依赖里，不算新增）；
  **不用 `std::process`** —— 同步跑会阻塞 UI，与下一条「调用走 async」冲突。
- 不在客户端存任何 token；登录态完全归 `gh` 自己管。
- 所有 gh 调用必须有超时：列表 10s、详情 10s、diff 20s。
- 调用走 async，不阻塞 UI 线程。
- 不碰 `dangerouslySetInnerHTML`（PR 正文只渲染纯文本 + 链接白名单，与 markdown 那条约束一致）。

## 1.1 分层与解耦（硬要求）

通信层（跑 `gh` 进程）与业务层必须各管一件事，**依赖只能朝一个方向**：

```
commands（Tauri 命令 / DTO）
      ↓ 只依赖
domain（模型 + 缓存 + 编排）      ← 只认 trait GhCli，不认 gh 命令行长什么样
      ↑ 由
adapter（src-tauri/src/gh/cli.rs，实现 trait GhCli：进程、argv、超时、JSON 解析、错误映射）
```

### 四条不许

| 不许 | 原因 |
| --- | --- |
| adapter 里出现 `tauri`、`AppState`、会话、数据库、DTO 序列化 | 通信层不认识业务；它要能脱离应用单独测 |
| domain / commands 里出现 `std::process`、`Command`、`--json`、`headRefName` 这类 CLI 细节 | 换数据源（哪怕以后真换了）只动 adapter，业务层零改动 |
| gh 的原始 JSON 结构（`RawPr` 之类）泄漏到 adapter 之外 | 原始形状随 gh 版本变，泄漏一次就变成全局债 |
| 前端直接拿到 gh 字段名 | 前端只认 DTO；`types.ts` 里的字段是自家命名的，不是 gh 的 |

### 契约只有三样

1. **trait**（放在 domain 侧定义，adapter 实现）：

   ```rust
   #[async_trait]
   pub trait GhCli: Send + Sync {
       async fn status(&self) -> Result<GhStatus, GhError>;
       async fn list_prs(&self, repo: &RepoRef, state: PrState) -> Result<Vec<PullRequest>, GhError>;
       async fn pr_detail(&self, repo: &RepoRef, n: u32) -> Result<PullRequestDetail, GhError>;
       async fn pr_diff(&self, repo: &RepoRef, n: u32) -> Result<String, GhError>;
   }
   ```

2. **领域模型**（domain 定义，只在 domain 与 commands 之间流动）：`RepoRef` / `GhStatus` / `PullRequest` / `PullRequestDetail` / `GhError`。

3. **错误枚举**（domain 定义）：`GhError { NotInstalled, NotLoggedIn, RateLimited{reset}, RepoUnavailable, Timeout, ParseFailed{version}, CliFailed{stderr} }`，
   码只在一个地方映射：`impl GhError { fn code(&self) -> u16 }`。**adapter 只负责把 stderr 文本判成枚举，不碰数字码**。

### 装配点（守住「删掉 cli.rs 仍能编译」这条线）

`commands` 只认 `Arc<dyn GhCli>`，**不出现 `RealGh`**。装配在 `lib.rs`：构造 `RealGh` 后塞进 `AppState` 的
`gh: Arc<dyn GhCli>` 字段。这样 `cli.rs` 的增删只波及 `lib.rs`，`domain` 与 `commands` 照旧编译。
反之，若 `commands` 里出现 `use crate::gh::cli::RealGh`，上面那条硬线就名存实亡。

### 探测的可测性（否则「假 gh 进 PATH」这条验收写不成稳定单测）

`RealGh` 的**探测根**（PATH + 三条固定路径）与可执行名必须是构造参数，默认值才从环境取：

```rust
RealGh::new()               // 生产：PATH + %ProgramFiles% + %LOCALAPPDATA% + scoop shims
RealGh::with_roots(roots)   // 测试：tempdir 里放 stub，不碰真实环境
```

两个原因：改进程级 `PATH` 是全局副作用，测试之间互相污染；Windows 原生 `cargo test` 没有 sh 解释器，
所以 stub 必须是 `.cmd`（`cmd.exe` 可直接执行），不是 `.sh`。

### 各层职责一览

| 层 | 有 | 没有 |
| --- | --- | --- |
| adapter | 探测路径、argv、超时、进程生命周期、stderr→枚举、raw JSON→领域模型 | 缓存、TTL、排序、分页切片、DTO、`tauri::` 任何东西 |
| domain | TTL 缓存（列表 30s / 详情 5min）、排序、diff 按行切片、并用 trait 编排调用 | 进程、argv、字段名、错误码数字 |
| commands | 入参校验、DTO 映射、`code()` 取码、日志 | gh 调用细节、解析、缓存逻辑 |

**缓存放 domain 而不是 adapter**：这样 adapter 保持无状态，domain 的缓存逻辑可以用假 adapter（fixture JSON）单测，不需要机器上装 gh。

**文件落点**：`model.rs` = domain（模型 + `GhCli` trait + `GhError` + `code()`）；`cli.rs` = adapter；
`mod.rs` = 命令层（`#[tauri::command]` + DTO + 取码 + 日志）。
`gh_status` 的 30s 缓存落在 domain（`service.rs::GhService`，持 `Arc<dyn GhCli>`），commands 只调 service ——
TTL 不进命令层，也不进 adapter。

### 可测性（这是分层的验收方式，不是口号）

- **domain 测试**：实现一个 `FakeGh`（返回捕获下来的真实 JSON 反序列化后的领域模型 / 直接返回 `GhError`），
  验证缓存命中、TTL 过期、排序、切片边界、错误码映射。**不需要 gh 在场。**
- **adapter 测试**：用一个 stub 脚本冒充 `gh`（`tests/fixtures/fake-gh.cmd`，按 argv 吐捕获的 JSON / 退出码 / stderr，
  经 `RealGh::with_roots` 注入），验证探测、版本解析、四类 stderr→枚举、超时。**不需要网络。**
- **端到端**：真机真 gh，只跑 E9.5 的冒烟脚本。

判断是否解耦成功的一条硬线：**把 `src-tauri/src/gh/cli.rs` 整个删掉，domain 与 commands 应当仍能编译**（trait 与模型都在 domain 侧）。做不到就是解耦没做到。

## 2. 可用性探测（这是本功能的第一道门）

`gh_status` 返回：`{ available, version?, loggedIn, host, cwdOk, ghPath? }`。

探测顺序（找到即停）：

1. `PATH` 里的 `gh`
2. `%ProgramFiles%\GitHub CLI\gh.exe`
3. `%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe`
4. `%USERPROFILE%\scoop\shims\gh.exe`

**实测（2026-10-28，本机 Windows）**：gh `2.103.3` 装在 `C:\Program Files\GitHub CLI\gh.exe`，
但 `where.exe gh` **无输出**（安装目录不在 PATH）⇒ 第 2 条兜底路径不是可选项，是唯一命中路径。
所以「有 gh」这条验收必须能覆盖「PATH 探测 miss、固定路径命中」这种组合，不能只测 PATH。

判定：

| 步骤 | 命令 | 超时 | 结论 |
| --- | --- | --- | --- |
| 存在性 | 上面 4 个路径 | — | 都没有 → `available=false` |
| 可运行 | `gh --version` | 2s | 失败 → `available=false`（版本解析失败也算，但要记日志） |
| 已登录 | `gh auth status` | 5s | 非 0 → `loggedIn=false` |

**为什么要先探测**：spike 实测「gh 不存在」时进程根本没起来，`rc` 仍是 0（报错来自 `env:`），
只看退出码会把「没装」误判成「成功但空列表」。

结果缓存 30s；前端「重新检测」按钮强制刷新（传 `force: true`）。

## 3. 错误码（落在既有 50700 段，不造新段）

`50700–50799` 的定位是「客户端辅助设施」，gh 是外部辅助工具，落在这一段。

| 码 | 含义 | 人话 |
| --- | --- | --- |
| `50710` | gh 未安装 | 「没找到 GitHub CLI（gh）」+ 安装指引 |
| `50711` | 未登录 / token 失效 | 「gh 还没登录 GitHub」+ `gh auth login` |
| `50712` | 限流 | 「GitHub 限流了，稍后再试」+ reset 时间 |
| `50713` | 仓库不存在 / 无权限 | 「这个仓库拿不到：不存在或当前账号无权限」 |
| `50714` | 执行失败 / 超时 | 「gh 执行失败」+ stderr 首行 |
| `50715` | JSON 解析失败 | 「gh 返回了看不懂的数据」+ 版本号（多为版本过旧） |

实测信号（spike）：

- 仓库不存在 → `GraphQL: Could not resolve to a Repository with the name '…'. (repository)`
- 失效 token → `HTTP 401: Bad credentials (https://api.github.com/graphql)`
- 限流 → `HTTP 403` + `rate limit`（未触发，按文本匹配兜底）

## 4. 领域模型（必须允许可空）

```ts
interface GhAuthor { login: string; name?: string; isBot: boolean }
interface GhPullRequest {
  number: number; title: string; url: string;
  state: "open" | "draft" | "merged" | "closed";
  author: GhAuthor;
  head: string; base: string;
  updatedAt: string;              // ISO8601
  mergeable?: "mergeable" | "conflicting" | "unknown";
  reviewDecision?: string;        // 可能为空串 → 存成 undefined
  checks: "pending" | "passing" | "failing";
}
```

三条来自实测的约束：

1. `author` 是对象 `{id, is_bot, login, name}`，不是字符串 —— 拍平成 `login` + `isBot`。
2. `mergeable` 对**已合并/已关闭**的 PR 是 `UNKNOWN`，`reviewDecision` 可能为空串 —— 两者都必须可空，
   不许当必然存在（否则已合并的 PR 渲染会崩）。
3. `files` 是 `[{path, additions, deletions, changeType}]`，**没有 patch 内容**。

## 5. diff 与分页

GitHub 没有「按行取 patch」的口子（REST 的 `pulls/{n}/files` 也没有 patch），所以：

- 逐行 diff 只能取 `gh pr diff <n>` 的整包（spike：PR #3 → 39,766 B / 11 文件，随 PR 线性增长）；
- **客户端切片**：整包落后端缓存，命令 `gh_pr_diff(pr, page, pageSize=200)` 按行切；
- 不把整包塞进事件或列表响应；大 PR 首批只取前 200 行。

E9 原卡里「单页 ≤ 200 行」据此改成「客户端对 patch 切片，每片 ≤ 200 行」。

## 6. UI（代码视图切换即检测）

- 侧栏切到代码视图（tab `kind: "repo"`）时调用 `gh_status`；**不是**只在启动时查一次。
- 不可用时**在栏内**给简易安装步骤（不弹全屏对话框，不阻止继续用其它功能）：

  ```
  没找到 GitHub CLI（gh）
  1. 安装：winget install --id GitHub.cli      （或 scoop install gh）
  2. 登录：gh auth login
  3. 回来点「重新检测」
  命令可复制；装好前 PR 列表为空
  ```

- 已安装未登录 → 只显示第 2 步；登录后点「重新检测」。
- 三态齐备：加载中（骨架）/ 不可用（安装指引）/ 空（这个仓库没有 PR）。
- 安装指引是纯文本 + 可复制的命令；**点按钮不替用户执行安装**（不静默跑 winget）。

## 7. 验收与冒烟映射

| 验收点 | 怎么验 | 期望读数（真实） |
| --- | --- | --- |
| gh 未安装 → 50710 + 安装指引 | 把 `PATH` 与 4 个探测路径都弄空（临时改目录或重命名） | 栏内出现三步指引，命令可复制，无崩溃 |
| gh 已安装 → `available=true` | 真机点「重新检测」（Windows，2026-10-28） | `available=true`；`version=2.103.3`；`ghPath=C:\Program Files\GitHub CLI\gh.exe`（`where.exe gh` 无输出 ⇒ 命中的是第 2 条固定路径）；`loggedIn=true`，账号 `wangsyiiz` |
| 未登录 → 50711 | `GH_TOKEN=bad` 或 `gh auth logout` | 只显示「登录」一步 |
| 列表可用 | `gh pr list --state all --limit 30 --json …` | 5 条 PR，1022–1130 ms，1,765 B |
| 已合并 PR 可渲染 | 打开 `#5`（merged） | `mergeable=unknown` 不崩，checks 显示 signed-off |
| 详情 | `gh pr view <n> --json …` | ~1.1 s，3,174 B |
| diff 切片 | `gh_pr_diff(3, 0, 200)` | 首页 200 行，整包 39,766 B 落缓存 |
| 仓库不存在 → 50713 | 指向 `wangsyiiz/nope-xyz-123` | 人话错误，不显示空列表 |
| 不写 token | 全仓搜 `gh auth token` | 0 处 |

## 8. 不做

- 不做 GitHub API 直连（不用 REST/GraphQL，不实现 OAuth 设备流）—— 所有者 2026-10-27 定。
- 不做写操作（评论 / 建 PR / 合并 / 审阅）。
- 不读 `~/.config/gh/hosts.yml` 复用 token（那是越界读别人的凭据文件）。
- 不做 issue 列表（本批只 PR；issue 单独立项）。

## 9. spike 读数出处

`/mnt/c/source/sincearc-spikes/001-gh-json-path/README.md`（含 `measure.sh` 可复现）。
关键数字：gh 进程启动 ~218 ms；列表 1022/1130/1095 ms；详情 1152/1032/1117 ms；diff 1823/1752/1767 ms；
curl 直连 REST 1,013 ms（更快这一点不成立，网络是主导项）。
