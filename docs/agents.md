# Agent 模型：一个「连接」到底描述了什么

范围：配置里怎么表达「连哪个 agent」、预设从哪来、怎么验证一条命令真的能起 ACP agent。

## 1. 连接 = 启动位置 × agent 命令

```
AgentProfile = { launch, distro/shell | ssh, cwd, program, args, defaultMode }
                └── 在哪启动 ──┘   └── 启动什么 ──┘
```

这两件事必须分开填，因为它们自由组合：

- `hermes acp` 跑在本机 WSL 里
- `npx -y @agentclientprotocol/claude-agent-acp` 跑在同一个 WSL 里
- 同一个 agent 跑在远程 SSH 主机上

早期实现把 `program`/`args` 写死成 `hermes` + `acp`，界面上只有「连接方式」——
那就等于把自己做成 hermes 专用客户端。现在两者都可以配。

## 2. 预设从哪来

来源是 ACP 官方注册表：
`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
（2026-10-21 快照：43 个 agent）。

注册表里 `distribution` 只有三种形态，命令可以直接推出来：

| 形态 | 字段 | 推导出的命令 |
|---|---|---|
| `npx` | `{ package, args? }` | `npx -y <package> <args...>` |
| `uvx` | `{ package, args? }` | `uvx <package> <args...>` |
| `binary` | `{ "<platform>": { cmd, args } }` | `<cmd> <args...>`（要求机器上已装） |

代码里只内置 7 个（`src/lib/agentPresets.ts`），每个都写了 `origin`（出处）和 `requires`（前置条件）。
**不把 43 条全塞进代码**：没跑过的命令写进去，只会让用户点一次、遇一次错。

## 3. 明确不做：自动下载 binary

`binary` 分发带各平台的下载地址和 sha256，理论上可以「点一下就装」。不做，理由：

- 装软件是用户机器上的副作用，客户端替用户下载并执行二进制，出问题无法解释；
- 每个 agent 的安装位置、升级、卸载都不同，我们会变成半个包管理器；
- 用户自己装好、把命令填进来，这条路径简单且可解释。

## 4. 验证：探测（`agent_probe`）

「这条命令是不是 ACP agent」不能靠命令名猜。探测的语义是：用这个连接配置真的起一次进程，
发一次 `initialize`，拿到 `agentInfo`，然后立刻 kill。

- 超时 20 秒（比正常连接短：用户点了按钮就在等）；
- **不保留进程**，也不建立会话 —— 探测验的是命令，不是连通状态；
- 失败时把 agent 的 stderr 带出来。实测：program 写错时报
  `handshake failed: agent closed stdout` + `zsh:1: command not found: definitely-not-an-acp-agent`；
  program 正确时报 `hermes-agent 0.22.2 · protocol v1`（`tests/agent_probe.rs` 是可执行版本）。

## 4.1 起不来时，错误必须自证原因

`50200` 是「启动或握手失败」的兜底码，它会把三种完全不同的原因糊成同一句话：

| 真实原因 | 以前看到的 |
|---|---|
| 工作目录是空串（新建 profile 的默认值） | `handshake failed: agent closed stdout` |
| 命令不在 PATH 上 | 同一句 |
| agent 起来了但立刻退出 | 同一句 |

所以起进程前先做静态校验，并且把**跑的是什么命令、在哪个目录**写进错误里：

| 码 | 含义 | 用户该做什么 |
|---|---|---|
| `50201` | 工作目录为空 | 填工作目录 |
| `50202` | agent 命令为空 | 选一个预设或填命令 |
| `50200` | 真的起不来 | 看错误里带出的命令行、目录和 agent 的 stderr |

实测（`tests/probe_diagnostics.rs`，同一套代码路径各跑一遍）：

```
wsl + hermes + 正常 cwd      → OK  hermes-agent 0.22.2
wsl + hermes + 空 cwd        → FAIL handshake failed: agent closed stdout   ← 这就是 50200 的来源
wsl + npx gemini 预设        → OK  gemini-cli 0.65.0
wsl + 不存在的程序            → FAIL 附带 zsh:1: command not found: no-such-agent
ssh + 没填 host              → 50300 SSH 主机未填（更早一步就被拦下）
local + hermes（Windows 侧）  → FAIL spawn `hermes` failed: program not found
```

## 4.2 能力面板：协议能力 vs CLI 扩展

标题栏那颗「能力」按钮里其实是两块东西，来源完全不同，不能混：

| 区块 | 来源 | 覆盖范围 |
|---|---|---|
| 协议能力 | 握手 `initialize` 的 `agentCapabilities` | **每个** agent 都有，换 agent 后跟着变 |
| ACP 之外的 CLI 扩展 | 代码里按 agent 名配的表（`src/extensions/registry.ts`） | 目前只有 hermes 有 |

早期实现只做了第二块，而且按钮以「有 CLI 扩展」为渲染条件 —— 于是 Codex / Claude 这类 agent
连入口都没有，而它们的协议能力恰恰是用户最想知道的。

现在的处理：

- 后端把 `agentCapabilities` 摊平成一组稳定的键（`loadSession / image / audio / embeddedContext /
  list / fork / resume / delete / mcp`），只认协议里定义的字段，不认识的丢弃；
- 前端把键翻成中文，支持的打勾、不支持的画横线（「不支持」本身也是信息）；
- 还没连过时按钮不出现；连过之后即使只有协议能力也会出现，并显示「能力 N」。
- 顺带修了 `previewCommand` 里写死 `hermes` 的问题：换成别的 agent，命令预览会照实拼。

实测（`tests/agent_probe.rs`）：

```
hermes-agent 0.22.2 · protocol v1
capabilities = ["loadSession", "image", "fork", "list", "resume"]
```

## 5. 已知限制

- `npx` 预设首次运行要下载包，探测会因此慢（甚至超时）。这是 `npx` 的性质，不是探测的问题 ——
  需要用户机器上有 node/npx，远端连接则要求那台机器上有。
- 预设里钉了版本号（如 `@google/gemini-cli@0.65.0`）。版本来自注册表快照，
  升级要改这一处表；好处是行为可复现，不会今天能连明天不能连。
- 改了 `program`/`args` 之后，已建立的连接还是旧的，要重新连接才生效（界面上有提示）。

## 6. 验收

自动：

```
cargo test --test agent_probe -- --ignored --nocapture --test-threads=1
```

手工：

1. 新建连接 → Agent 选 `Gemini CLI` → 命令栏显示 `npx -y @google/gemini-cli@0.65.0 --acp`。
2. 点「探测」→ 成功则显示 agent 名与版本；把命令改成不存在的程序再探测 → 显示错误与 stderr。
3. 选「自定义命令」→ 粘贴一条自己的命令 → 探测通过 → 打开会话能连上。
