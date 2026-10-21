# Agent 发现规范（E1.3）

目标：第一次启动就把「这台机器上哪些 agent 能当 ACP 服务端跑」摸清楚，用户不必事先知道
要装什么、装在哪、命令叫什么。

---

## 1. 先回答一个容易搞错的问题：装了这个 CLI，不代表它能起 ACP

实测（2026-10-21）：`codex --help` 的子命令里**没有** `acp`。codex 要走 ACP 必须靠
`codex-acp` 适配器（`npx -y @agentclientprotocol/codex-acp`）。所以「发现到 `codex` 在 PATH 上」
只能说明**底层 CLI 在**，不能推出「可以拿它起 ACP」。

候选表因此有三列，缺一不可：

| 列 | 含义 |
|---|---|
| `binary` | 用来判断「装没装」的命令名 |
| `mode` | `native`（CLI 自己说 ACP）/ `adapter`（需要额外适配器） |
| `acp` | 真起服务端的命令（program + args） |

已知三种形态：

| agent | binary | mode | ACP 启动命令 | 依据 |
|---|---|---|---|---|
| Hermes Agent | `hermes` | native | `hermes acp` | 实测握手 → hermes-agent 0.22.2 |
| Gemini CLI | `gemini` | native | `gemini --acp` | ACP Registry 的 npx 条目带 `--acp` |
| Qwen Code | `qwen` | native | `qwen --acp --experimental-skills` | 同上 |
| OpenCode | `opencode` | native | `opencode acp` | Registry binary 条目 `args: ["acp"]` |
| Goose | `goose` | native | `goose acp` | Registry binary 条目 `args: ["acp"]` |
| Codex | `codex` | **adapter** | `npx -y @agentclientprotocol/codex-acp` | 实测 `codex --help` 无 acp 子命令 |
| Claude Agent | `claude` | **adapter** | `npx -y @agentclientprotocol/claude-agent-acp` | Registry 只有 npx 适配器包 |

> 「native 的 CLI 装好了」→ 直接用它起；「adapter 的底层 CLI 装好了」→ 仍然要适配器，
> 界面上要说清这一点，不能让用户以为 `codex acp` 能跑。

## 2. npx 预设与本地已装的关系

现在预设全是 npx，问题是：**用户机器上已经装了 `gemini`，再去 `npx -y @google/gemini-cli@0.65.0`
等于又下一份、版本还被钉死**。

规则（按优先级）：

1. 发现到本地可用的 `native` 命令 → 用它（`gemini --acp`），不碰 npx；
2. 发现到 `adapter` 的底层 CLI（`codex` / `claude`）→ 提示「底层 CLI 在，但需要适配器」，
   给 npx 适配器作为默认选择（仍标出会下载）；
3. 什么都没发现 → npx 预设作为「不用装也能试」的兜底，明确标注「会下载」与钉住的版本；
4. 都不想要的 → 自定义命令。

## 3. 扫描范围

| 环境 | 怎么找 | 备注 |
|---|---|---|
| Windows 本机 | `where <binary>` | `where` 返回码非 0 = 没装 |
| WSL | 发行版来自 `wsl.exe -l -q`；每个发行版跑 `sh -lc 'command -v <b> \|\| ls $HOME/.local/bin/<b>'` | login shell 不读 `.zshrc`，`~/.local/bin` 要额外看一眼（hermes 就装在那儿） |
| SSH | **只扫用户已存连接配置的 host** | 不去扫未知主机 |

扫描是后台任务：不阻塞窗口，结果进缓存。触发点：

- 首次启动（库里没有 `discovery.done_at`）跑一次；
- 设置页「重新扫描」随时手动跑；
- 两次扫描之间界面直接读缓存，不每次重探。

## 4. 发现的结论要验证过才算数

「`gemini` 在 PATH 上」不等于「它能起 ACP」。所以：

- 扫描只负责**找人**（存在性），结果标为「已发现，未验证」；
- 点「验证」用 `agent_probe`（真起一次 initialize）—— 与设置页那个按钮是同一条路径、同一套错误码。

两层分开的好处：扫描可以很快、很宽（多发行版 × 多命令），验证只对用户真正想用的那一个做。

## 5. 不做

- 不自动 `npm install` / 下载 binary。装软件是用户机器上的副作用（同 `docs/agents.md` §3）。
- 不去扫未知 SSH 主机（会和用户的 known_hosts 打架，也可能是别人的机器）。

## 6. 实现进度

| 项 | 状态 |
|---|---|
| 候选表（7 条）+ 扫描本机 / 各 WSL 发行版 | ✅ `src-tauri/src/acp/discover.rs` |
| 结果缓存进 `app_meta` | ✅ 只存扫出来的结果，候选表来自代码 const |
| 启动先读缓存、没有才后台扫 | ✅ `useDiscovery`（挂载即跑，不阻塞界面） |
| 设置页「重新扫描」+ 分组列表 + 逐条验证 | ✅ 连接区底部 |
| 「用它建连接」（带上 program/args/环境/家目录） | ✅ |
| SSH 扫描（只扫已存连接的 host） | ✅ 复用启动层；⚠️ 真机未验（本机 sshd 只有密码认证，需要真实凭据） |

## 7. 两个把扫描打回零结果的坑（实测）

1. **`sh -lc` 不能用**：WSL 的 `/etc/profile` 会把 Windows 的 PATH 拼进来，里面有
   `Program Files (x86)`，未加引号 → `syntax error near unexpected token '('`，
   脚本后半段整段不执行。表现是「明明装了 agent，扫出 0 个」。改成 `sh -s` + 自己拼 PATH。
2. **多行脚本不能当 `-c` 的单个参数穿过 `wsl.exe`**：`\t` 与 `\"` 会被它的参数转义吃掉，
   结果是 `sh` 静默 `exit 1`、什么都不输出。同样的脚本写成文件执行则完全正常 ——
   所以问题在参数传递，不在脚本。现在统一走 **stdin**（`sh -s`），SSH 那条路径也一样。

换句话说：跨 `wsl.exe` / `ssh.exe` 的探测脚本，一律用 stdin 喂，不要拼进命令行。

## 8. 验收

1. 本机装了 `hermes`、没装 `gemini` → 扫描结果：hermes 已发现（native），gemini 未安装。
2. WSL 里装了 `hermes`、Windows 侧没有 → 结果里标 `wsl:fedora`，不是 `local`。
3. 装了 `codex` → 标 `adapter`，并写清「需要适配器」，默认给 npx 适配器命令。
4. 点验证 → 复用 `agent_probe`；空 cwd 报 `50201` 而不是 `50200`。
5. 关掉应用重开 → 结果来自缓存，不再重新扫描（除非点「重新扫描」）。
