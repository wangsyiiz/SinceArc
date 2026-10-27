<p align="center">
  <img src="assets/brand/logo.png" alt="SinceArc" width="112" height="112">
</p>

<h1 align="center">SinceArc</h1>

<p align="center">
  你手上一堆 agent 的一个窗口：几个 CLI agent、它们的会话和子 agent 都在同一处——
  而每个回答背后的思考被放到一边，需要时再翻。
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg">
  <img alt="Version" src="https://img.shields.io/badge/version-0.0.1-orange.svg">
  <a href="https://github.com/wangsyiiz/SinceArc/actions/workflows/release.yml"><img alt="Release build" src="https://github.com/wangsyiiz/SinceArc/actions/workflows/release.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <img src="website/assets/dark.png" alt="SinceArc" width="820">
</p>

---

## 这是什么

SinceArc 是一个用 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 连 agent 的 Windows 桌面客户端，
Tauri 2 + React 19 + TypeScript + Rust，数据落本地 SQLite，不上传。

它围绕的是**聚合**。只跑一个 agent 时终端够用；同时跑四个——一个规划、一个写代码、一个评审，再加上昨天开的那个
你已经忘了 cwd 在哪的——就不够用了：上下文在窗口之间复制，谁在做哪件事慢慢就乱了，而且没有地方告诉你它们究竟做了什么。
SinceArc 把它们放到同一条时间轴上，共用一套会话、一套连接配置，并且有一个地方能回答「现在每个人在干什么」。
它**以群聊的形式提供更便捷的 agent 体验**：agent 作为成员进到会话里，跟四个 agent 协作更像一场对话，
而不是在四个窗口之间来回切。

## 为什么做这个

**1. 多 agent，一处管理**（主要理由）

- **连接配置（profile）**描述一次 agent 启动：本机、某个 WSL 发行版，或经 SSH 的远端——各有自己的 cwd、环境变量
  与 MCP 服务器。换 agent 是按会话换，不是按终端窗口换。
- **群聊**：把 agent 加成会话成员，`@` 其中一个，它就在自己的支线上并行跑，答完弯回主干；它说的话始终归属于它。
- **每个会话一份轨迹**，收集**所有成员**做过的事，可按玩家过滤——只看评审那位的工具调用，或看全貌。
- **各 agent 的 `/` 命令自动探测**：agent 通过 ACP 把自己的命令表报上来（`session/update`），客户端按 ACP 会话
  存着——所以 `/` 菜单跟着你正在对话的那个 agent 走。群聊里规划和写代码的两位菜单各不相同，不用手写清单，
  也不用配置。
- **审批、MCP 服务器、存储占用**都在同一个窗口里管，不用去翻五份 shell 配置。

**2. GitHub 桌面客户端**——*规划中*。PR、issue、评审进同一个窗口，agent 通过 ACP 参与其中。列在这里是因为这是
这套架构下一步顺手能做的事，不是因为它已经存在。见 [Roadmap](#roadmap)。

**3. 过程与正文分离。** 回答留在对话里；思考、工具调用、权限请求进轨迹面板，两者靠锚点互跳。出了问题能回查
「它当时为什么这么干」，而不用在一屏滚动里翻。

## 能力

| 能做 | 说明 |
| --- | --- |
| 聚合多个 agent | 多套连接配置；每个会话自己选 agent；本机 / WSL / SSH 三种启动形态 |
| 群聊与子 agent | `@` 成员让它单开一条支线并行跑，答完弯回主干 |
| 一份轨迹给所有人 | 按玩家分泳道与过滤；列表虚拟化；活动数 > 1500 时图视图降级 |
| 各 agent 的 `/` 命令 | 由 agent 经 ACP 上报、按会话保存，菜单跟着当前对话的 agent 变 |
| 审批 | 按类型分档，支持「本轮同类自动允许」（内存策略，轮末失效） |
| 流式回答 | 补间过渡、收口优先（轮结束立刻对齐全文），可在设置里关掉 |
| markdown 渲染 | 围栏代码块 / 行内 code / 列表 / 表格 / 链接；只解析成元素，不注入 HTML |
| 代码高亮 | Prism，五套主题，行内 code 同主题；默认 SinceArc 配色 |
| 外链安全打开 | scheme 白名单，前后端各校验一次 |
| 存储提示 | 只统计、只提示，不自动删任何东西 |

**明确没做的**（写在这里，省得装了才发现）：

- 只有 **Windows x64**；macOS / Linux / ARM64 都没做，也没有未验证的产物；
- **没有代码签名**，首次运行 SmartScreen 会提示「未知发布者」；
- **没有自动更新**，升级靠手动下新包；
- **还没有 GitHub 集成**——那在 Roadmap 上，不是现成功能；
- **没有单实例 / `sincearc .` 反向入口**；
- 轨迹面板一次只取 50 轮（服务端上限 200 轮），**翻不到更早的轨迹**。

## 安装

> 已发布：`v0.0.1`（Windows x64 预览版，未签名）。自动更新已内置——设置 → 更新。

1. 到 [Releases](https://github.com/wangsyiiz/SinceArc/releases) 下载 `SinceArc-win-x64.zip`（便携）或
   `SinceArc_x64-setup.exe`（安装）。文件名不带版本号是有意的：永远指向最新发布，链接不会过期；
2. 便携版解压到任意目录（别在压缩包里直接双击），双击 `SinceArc.exe`；
3. SmartScreen 提示时点「更多信息 → 仍要运行」（未签名）；
4. 需要 WebView2 运行时：Win11 与较新的 Win10 自带；缺的话装
   [Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。

数据在 `%APPDATA%\com.sincearc.app`（`sincearc.db` + `logs\`）。删程序文件夹不会删数据，
要彻底清干净就删这个目录。完整口径见 [`docs/distribution.md`](docs/distribution.md)。

## 从源码构建

需要：Windows、Node 20+、Rust stable（`rust-version = 1.77.2` 起）、WebView2 Runtime。

```powershell
npm ci
npm run tauri -- build --no-bundle     # 产物：src-tauri/target/release/sincearc.exe
npm run package:win                    # 产物：artifacts/windows/SinceArc-<version>-win-x64.zip
```

开发：

```powershell
npm run tauri dev    # 前端 vite + Rust 壳（debug 版从 http://localhost:5173 取页面）
npm run dev          # 只跑前端
```

> `npm install` / `npm ci` 必须用 **Windows 侧 Node**。在 WSL 里装会把 lockfile 的 rolldown 原生绑定
> 写成 Linux 版，之后 `vite build` 报 `Cannot find native binding`。

发布走 CI：推 `v*` tag 或手动跑 `release` workflow，Windows runner 上同时产出便携包与 NSIS 安装包
（本地做不出安装包——Tauri 首次打包要从 GitHub 下 NSIS，见 [`docs/distribution.md`](docs/distribution.md) §6）。

## 架构

```
src/                      前端：React 19 + TS + Tailwind 4（Vite 构建，产物内嵌进 exe）
  lib/ipc/                命令封装（组件里禁止写命令字符串）
  lib/virtual/            虚拟列表（唯一 import @tanstack/react-virtual 的地方）
  lib/highlight/          Prism 适配 + 主题表
  lib/markdown.ts         marked.lexer → 自己的块/行内模型（不产出 HTML 字符串）
src-tauri/src/
  acp/                    ACP 连接、进程管理（Local / WSL / SSH 启动形态）、事件采集
  db/                     SQLite（atoms 单一权威 + turns/sessions/members；编号迁移）
  commands.rs             IPC 命令层（业务计算都在 Rust，前端只做展示）
docs/                     规范（先写规范再写代码）
```

改代码前必须知道的几条（详见 [`docs/dev-rules.md`](docs/dev-rules.md) 与 [`docs/architecture.md`](docs/architecture.md)）：

- ACP 类型只出现在 `src-tauri/src/acp/`，前端只吃 DTO；
- 流式 token 进 zustand，不进 React Query cache；
- 正文渲染**全程不碰 `dangerouslySetInnerHTML`**，链接只放行 `http` / `https` / `mailto`；
- 轨迹只收通知类事件（thought / tool_call / mode / usage），对话正文不进轨迹；
- 长列表行高由内容决定，估算值只喂虚拟化器，不写死 `height`。

## 开发与门禁

```powershell
npm run build                                      # tsc -b && vite build
npm test                                           # node --test "src/**/*.test.ts"
cd src-tauri; cargo test --lib
cd src-tauri; cargo clippy --all-targets -- -D warnings
```

当前基线（`0.0.1`）：cargo **277** / node **228** / tsc 0 / vite ≈ 3s。

> `kill_tree_reaps_forked_child_on_windows` 在机器忙时会超时变红：先查有没有残留 `powershell.exe`
> （`tasklist /FI "IMAGENAME eq powershell.exe"`），清掉再跑；汇报时把「全量」与「单跑」两个读数都写出来。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | 分层与数据流 |
| [`docs/dev-rules.md`](docs/dev-rules.md) | 开发禁令与约定 |
| [`docs/design-language.md`](docs/design-language.md) | 设计语言（面阶、材质、状态过渡一律补间） |
| [`docs/desktop-ux.md`](docs/desktop-ux.md) | 桌面交互逐条口径（补间 / markdown / tooltip / 高亮 / 虚拟列表） |
| [`docs/message-model.md`](docs/message-model.md) | 原子事件 → 块 → 消息 → 轮 |
| [`docs/ipc-contract.md`](docs/ipc-contract.md) | 前后端契约与错误码 |
| [`docs/permissions-spec.md`](docs/permissions-spec.md) | 审批与自动同意 |
| [`docs/distribution.md`](docs/distribution.md) | 打包与分发（平台口径、产物、签名） |
| [`docs/gh.md`](docs/gh.md) | GH 可视化：只做 gh CLI、可用性探测、错误码、diff 切片 |
| [`docs/licensing.md`](docs/licensing.md) | 免费与订阅的边界、三条红线 |

## 贡献

读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，最小集是两条：

1. **规范先行**：改行为先改 `docs/*.md`；写着「暂时就这样」「已知未收口」的地方是有意留的，别顺手改；
2. **一个实现只做一份**：开工前确认没人在同一条线上做同一件事。

提交用 `git commit -s`（DCO），CI 会校验 `Signed-off-by`。PR 描述里贴读数，不要只写「跑过了」。

## Roadmap

| 状态 | 方向 | 内容 |
| --- | --- | --- |
| 规划中 | GitHub 桌面客户端 | PR、issue、评审进同一个窗口，agent 通过 ACP 参与 |
| 规划中 | 分发 | 打首个 tag → 自动更新（tauri-plugin-updater）→ 官网 |
| 下一步 | 聚合 | 项目与位置（repo / worktree 隔离）；会话打开态与错误态矩阵 |
| 下一步 | 体验 | 轨迹分页翻得到更早；消息行高度地板 |

## 许可

[Apache-2.0](LICENSE)。客户端的一切功能永久免费且开源，不联我们的服务也能跑完整功能；
自我约束（三条红线）见 [`docs/licensing.md`](docs/licensing.md)。

`SinceArc` 名称与图标不随代码授权，fork 请改名换标（[`TRADEMARK.md`](TRADEMARK.md)）。

## 联系

- 官网：<https://sincearc.com/>
- 仓库：<https://github.com/wangsyiiz/SinceArc>
- 问题：<https://github.com/wangsyiiz/SinceArc/issues>
