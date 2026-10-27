# SinceArc

Windows 桌面上的 ACP（Agent Client Protocol）客户端：把 agent 的**思考与工具调用**从聊天正文里拆出来，
做成一条可以回看的泳道，正文只留「人对人说的话」。

Tauri 2 + React 19 + TypeScript + Rust，本地 SQLite 落库，数据不出机器。

> 当前版本 `0.1.0`，Windows x64 预览版。功能边界见下面「现在能做什么 / 不能做什么」，没做的就写没做。

---

## 它是干什么的

用 ACP 协议连 agent（本机进程，或 WSL 里的进程），在桌面上：

- **对话**：流式回答带补间过渡（不再一个字一个字崩）；正文两阶段渲染，回答结束才解析 markdown；
- **看过程**：一轮里的思考、工具调用、权限请求全部进轨迹面板——列表视图可长列表虚拟滚动，
  图视图按 agent 画泳道（活动数 > 1500 自动省略图视图并说明）；
- **多人（多 agent）**：一个会话可以是个群，`@` 某个成员让它单开一条支线并行跑，答完弯回主干；
- **审批**：权限请求按类型分档，可「本轮同类自动允许」（内存策略，轮末失效，不落库）；
- **可回溯**：会话、轮、原子事件都落 SQLite；轨迹能补录（重连后把断档补齐，幂等），
  也能按会话看存储统计——**只统计、只提示，不自动删任何东西**。

## 为什么做这个（构建目的）

现有的 agent 客户端大多把「思考 / 工具调用 / 回答」揉在一条消息流里：过程被正文淹没，
出了问题没法回查「它当时为什么这么干」。SinceArc 的取舍是：

1. **过程与正文分离**：正文只讲人话，过程进轨迹，两者靠锚点互找；
2. **本地优先**：会话、轨迹、设置全在 `%APPDATA%\com.sincearc.app`，不上传；
3. **不替用户处置数据**：删账号、删文件这类不可逆操作必须显式授权，程序不做「贴心」的自动清理；
4. **可诊断**：每一屏的读数都能用 CDP 量出来（滚动帧时间、虚拟行数、打开延迟），不靠「感觉快了」。

## 现在能做什么

| 能力 | 状态 |
| --- | --- |
| 连接 ACP agent（本机 / WSL） | ✅ |
| 流式补间、收口优先、可在设置里关掉 | ✅ |
| markdown 渲染（围栏代码块 / 行内 code / 列表 / 表格 / 链接） | ✅ 只解析成文本与元素，不注入 HTML |
| 代码高亮（Prism，五套主题，行内 code 同主题） | ✅ 默认 SinceArc 配色 |
| 轨迹面板：列表虚拟化 / 图视图 / 阈值降级 / 定位互跳 | ✅ |
| 多 agent 群聊与 `@` 成员 | ✅ |
| 权限审批 + 本轮同类自动允许 | ✅ |
| 外链安全打开（scheme 白名单，前后端各校验） | ✅ |
| 存储统计提示（不落库、不自动清理） | ✅ |
| Windows 便携包 | ✅（安装包待 CI，见 Roadmap） |

## 不能做什么（明确边界）

- **只有 Windows x64**：macOS / Linux / ARM64 都没做，也没有未验证的产物；
- **没有代码签名**：首次运行 SmartScreen 会提示「未知发布者」；
- **没有自动更新**：更新靠手动下新包；
- **没有单实例 / `sincearc .` 反向入口**；
- 轨迹面板一次只取 50 轮（服务端上限 200 轮），**翻不到更早的轨迹**——分页在 Roadmap 里。

## 安装（Windows）

1. 到 [Releases](https://github.com/wangsyiiz/sincearc/releases) 下载 `SinceArc-<version>-win-x64.zip`；
2. 解压到任意目录（不要在压缩包里直接双击），双击 `SinceArc.exe`；
3. SmartScreen 提示时点「更多信息 → 仍要运行」（未签名，见上）；
4. 需要 WebView2 运行时：Win11 与较新的 Win10 自带；缺的话去
   <https://developer.microsoft.com/microsoft-edge/webview2/> 装 Evergreen Runtime。

数据在 `%APPDATA%\com.sincearc.app`（`sincearc.db` + `logs\`）。删文件夹不会删数据；
要彻底清干净就删这个目录。详细口径见 [`docs/distribution.md`](docs/distribution.md)。

## 从源码构建

前提：Windows、Node 20+、Rust stable（`rust-version = 1.77.2` 起）、WebView2 Runtime。

```powershell
npm ci
npm run tauri -- build --no-bundle     # 出 src-tauri/target/release/sincearc.exe
npm run package:win                    # 出 artifacts/windows/SinceArc-<version>-win-x64.zip
```

开发时：

```powershell
npm run tauri dev      # 前端 vite + Rust 壳（debug 版从 http://localhost:5173 取页面）
npm run dev            # 只跑前端
```

> 本仓库在 Windows 上开发时，`npm install` / `npm ci` 必须用 **Windows 侧 Node**：
> 在 WSL 里装会把 lockfile 的 rolldown 原生绑定装成 Linux 版，`vite build` 会报
> `Cannot find native binding`。

## 架构一页

```
src/                      前端：React 19 + TS + Tailwind 4（Vite 构建，产物内嵌进 exe）
  lib/ipc/                命令封装（禁止在组件里写命令字符串）
  lib/virtual/            虚拟列表（唯一 import @tanstack/react-virtual 的地方）
  lib/highlight/          Prism 适配 + 主题表
  lib/markdown.ts         marked.lexer → 自己的块/行内模型（不产出 HTML 字符串）
src-tauri/src/
  acp/                    ACP 连接、进程管理（Local / WSL 两种启动形态）、事件采集
  db/                     SQLite（atoms 单一权威 + turns/sessions；编号迁移）
  commands.rs             IPC 命令层（业务计算全在这边，前端只做展示）
docs/                     规范（先写规范再写代码，见下）
```

关键约定（改代码前先读 [`docs/dev-rules.md`](docs/dev-rules.md) 与 [`docs/architecture.md`](docs/architecture.md)）：

- ACP 类型只出现在 `src-tauri/src/acp/`；前端只吃 DTO；
- 流式 token 进 zustand，不进 React Query cache；
- 正文渲染**全程不碰 `dangerouslySetInnerHTML`**；链接只放行 `http`/`https`/`mailto`；
- 轨迹只收通知类事件（thought / tool_call / mode / usage），对话正文不进轨迹；
- 长列表行高由内容决定（估算只喂虚拟化器，不写死 `height`）。

## 开发与门禁

```powershell
cd src-tauri; cargo test --lib                     # 单元测试
cd src-tauri; cargo clippy --all-targets -- -D warnings
npm run build                                      # tsc -b && vite build
npm test                                           # node --test "src/**/*.test.ts"
```

当前基线（`0.1.0`）：cargo **277** / node **228** / tsc 0 / vite ~3s。

> `kill_tree_reaps_forked_child_on_windows` 在机器忙时会超时变红：先查有没有残留
> `powershell.exe`（`tasklist /FI "IMAGENAME eq powershell.exe"`），清掉再跑；
> 汇报时把「全量」和「单跑」两个读数都写出来。

## 文档地图

| 文档 | 讲什么 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 分层与数据流 |
| [`docs/dev-rules.md`](docs/dev-rules.md) | 开发禁令与约定 |
| [`docs/design-language.md`](docs/design-language.md) | 设计语言（面阶、材质、状态过渡一律补间） |
| [`docs/desktop-ux.md`](docs/desktop-ux.md) | 桌面交互逐条口径（补间、markdown、tooltip、高亮、虚拟列表） |
| [`docs/message-model.md`](docs/message-model.md) | 原子事件 → 块 → 消息 → 轮 |
| [`docs/ipc-contract.md`](docs/ipc-contract.md) | 前后端契约与错误码 |
| [`docs/permissions-spec.md`](docs/permissions-spec.md) | 审批与自动同意 |
| [`docs/distribution.md`](docs/distribution.md) | 打包与分发（平台口径、产物、签名） |

## 贡献

欢迎 issue 与 PR，但请先看两条硬规矩：

1. **规范先行**：改行为先改 `docs/*.md`，规范里写着「暂时就这样」的地方不要顺手改掉；
2. **一个实现只做一份**：开工前先看有没有人在同一条线上做同一件事（分支 / 看板卡）。

分支与提交：

- 从 `master` 切 `feat/<topic>`，提交前 `git branch --show-current` 确认；
- 提交信息写「为什么」和读数，不只写「改了什么」；
- 新依赖要在 PR 里说清理由（体积 / 许可证 / 维护活跃度），并更新 `package-lock.json`（Windows 侧生成）。

PR 要求：`cargo test --lib`、`cargo clippy --all-targets -- -D warnings`、`npm run build`、`npm test` 全绿，
并在描述里贴读数（不是「跑过了」）。

## Roadmap

| 方向 | 内容 |
| --- | --- |
| 分发 | Windows 安装包（NSIS）→ GitHub Actions 出 release → 自动更新（tauri-plugin-updater） |
| 功能 | 项目与位置（repos / local_repos / worktree 隔离，E14）；会话打开态拓扑与错误态矩阵（E15） |
| 体验 | UIUX 优化（E18）：轨迹分页翻得到更早、消息行高度地板、长列表体感 |
| 官网 | GitHub Pages 单页（下载入口 + 三条卖点） |

## 许可

待定（见 issue / 看板 E19.2）。在 LICENSE 落地前，默认按「保留所有权利」处理，请先开 issue 沟通。

## 联系

- 仓库：<https://github.com/wangsyiiz/sincearc>
- 问题：<https://github.com/wangsyiiz/sincearc/issues>
