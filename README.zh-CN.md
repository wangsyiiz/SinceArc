<p align="center">
  <img src="assets/brand/logo.png" alt="SinceArc" width="112" height="112">
</p>

<h1 align="center">SinceArc</h1>

<p align="center">
  Windows 桌面上的 ACP 客户端：把 agent 的思考与工具调用从对话里拆出来，做成一条能回看的泳道。
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20x64-lightgrey.svg">
  <img alt="Version" src="https://img.shields.io/badge/version-0.0.0-orange.svg">
  <a href="https://github.com/wangsyiiz/SinceArc/actions/workflows/release.yml"><img alt="Release build" src="https://github.com/wangsyiiz/SinceArc/actions/workflows/release.yml/badge.svg"></a>
</p>

---

## 这是什么

SinceArc 是一个用 [ACP（Agent Client Protocol）](https://agentclientprotocol.com) 连 agent 的桌面客户端，
Tauri 2 + React 19 + TypeScript + Rust，数据落本地 SQLite，不上传。

它只做一件与别的客户端不一样的事：**过程与正文分家**。回答是回答，思考与工具调用进轨迹面板，
两者靠锚点互相跳转——出了问题能回查「它当时为什么这么干」，而不用在一屏滚动里翻。

<!-- 截图位：把图放到 assets/screenshots/ 后取消注释
<p align="center"><img src="assets/screenshots/main.png" width="720"></p>
-->

## 为什么做这个

现有 agent 客户端大多把思考、工具调用、回答揉在一条消息流里，过程被正文淹没。我们的四条取舍：

1. **过程与正文分离** —— 正文只讲人话，过程进轨迹，互不污染；
2. **本地优先** —— 会话、轨迹、设置全在 `%APPDATA%\com.sincearc.app`，不上传；
3. **不替用户处置数据** —— 删账号、删文件这类不可逆操作必须显式授权，没有「贴心」的自动清理；
4. **可诊断** —— 每一屏的性能都用 CDP 量得出来（滚动帧时间、虚拟行数、面板打开延迟），不靠「感觉快了」。

## 能力与边界

| 能做 | 说明 |
| --- | --- |
| 连接 ACP agent | 本机进程或 WSL 里的进程 |
| 流式回答 | 补间过渡、收口优先（轮结束立刻对齐全文），可在设置里关掉 |
| markdown 渲染 | 围栏代码块 / 行内 code / 列表 / 表格 / 链接；只解析成元素，不注入 HTML |
| 代码高亮 | Prism，五套主题，行内 code 同主题；默认 SinceArc 配色 |
| 轨迹面板 | 列表虚拟化、图视图泳道、活动数 > 1500 自动降级、与正文互跳定位 |
| 多 agent 群聊 | `@` 成员让它单开一条支线并行跑，答完弯回主干 |
| 审批 | 按类型分档，支持「本轮同类自动允许」（内存策略，轮末失效） |
| 外链安全打开 | scheme 白名单，前后端各校验一次 |
| 存储提示 | 只统计、只提示，不自动删任何东西 |

**明确没做的**（写在这里，省得装了才发现）：

- 只有 **Windows x64**；macOS / Linux / ARM64 都没做，也没有未验证的产物；
- **没有代码签名**，首次运行 SmartScreen 会提示「未知发布者」；
- **没有自动更新**，升级靠手动下新包；
- **没有单实例 / `sincearc .` 反向入口**；
- 轨迹面板一次只取 50 轮（服务端上限 200 轮），**翻不到更早的轨迹**——分页在 Roadmap 里。

## 安装

> 首个版本 `v0.0.0` 还没有打 tag，下面描述的是发布后的路径。

1. 到 [Releases](https://github.com/wangsyiiz/SinceArc/releases) 下载 `SinceArc-<version>-win-x64.zip`（便携）或 `SinceArc_<version>_x64-setup.exe`（安装）；
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
  acp/                    ACP 连接、进程管理（Local / WSL 两种启动形态）、事件采集
  db/                     SQLite（atoms 单一权威 + turns/sessions；编号迁移）
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

当前基线（`0.0.0`）：cargo **277** / node **228** / tsc 0 / vite ≈ 3s。

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
| [`docs/licensing.md`](docs/licensing.md) | 免费与订阅的边界、三条红线 |

## 贡献

读 [`CONTRIBUTING.md`](CONTRIBUTING.md)，最小集是两条：

1. **规范先行**：改行为先改 `docs/*.md`；写着「暂时就这样」「已知未收口」的地方是有意留的，别顺手改；
2. **一个实现只做一份**：开工前确认没人在同一条线上做同一件事。

提交用 `git commit -s`（DCO），CI 会校验 `Signed-off-by`。PR 描述里贴读数，不要只写「跑过了」。

## Roadmap

| 方向 | 内容 |
| --- | --- |
| 分发 | 打首个 tag → 自动更新（tauri-plugin-updater）→ 官网 |
| 功能 | 项目与位置（repos / worktree 隔离，E14）；会话打开态拓扑与错误态矩阵（E15） |
| 体验 | 轨迹分页翻得到更早、消息行高度地板、长列表体感（E18） |

## 许可

[Apache-2.0](LICENSE)。客户端的一切功能永久免费且开源，不联我们的服务也能跑完整功能；
将来若做订阅，卖的是**服务端能力**（账号同步 / 托管 agent / 团队协作），不是解锁客户端里的代码 ——
边界与自我约束见 [`docs/licensing.md`](docs/licensing.md)。

`SinceArc` 名称与图标不随代码授权，fork 请改名换标（[`TRADEMARK.md`](TRADEMARK.md)）。

## 联系

- 仓库：<https://github.com/wangsyiiz/SinceArc>
- 问题：<https://github.com/wangsyiiz/SinceArc/issues>
