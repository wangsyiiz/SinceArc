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
