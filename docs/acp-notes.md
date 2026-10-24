# ACP 接入笔记

## 对端

```
wsl.exe -d fedora --cd <cwd> -- zsh -lc "hermes acp"
```

握手实测（2026-10-20）：

```json
{"jsonrpc":"2.0","id":1,"result":{
  "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},
                       "sessionCapabilities":{"fork":{},"list":{},"resume":{}}},
  "agentInfo":{"name":"hermes-agent","version":"0.22.2"},
  "authMethods":[{...opencode-go...},{"id":"hermes-setup","type":"terminal"}],
  "protocolVersion":1}}
```

`authMethods` 里 `type: "terminal"` 的那个表示"去终端里跑这条命令"，不要为它做配置表单。

## 传输

stdio，**换行分隔的 JSON**，UTF-8，消息内不得含裸换行。
`wsl.exe` 中转实测字节保真（含中文），`\n` 不被改写成 `\r\n`。

- stdout 只放协议；stderr 是自由日志（hermes 启动会刷 60+ 行插件注册），必须单开一路。
- 读 stdout 按 `\n` 切分并保留残余片段，不能假设一次 read 正好一条消息。

## 进程生命周期

- 拉起 `wsl.exe` 只是 relay，kill 它不会杀 WSL 里的 agent：
  用 `setsid` 起，把 pid（也就是 pgid）记进 `/tmp/sincearc-<id>.pid`，
  回收时在 WSL/SSH 同一侧执行 `kill -TERM -<pid>`，2 秒后 `kill -KILL -<pid>`。
- 远端没有 `setsid` 时写 `*.nosetsid` marker，回收降级为只杀直接子进程并明确提示可能残留。
- `wsl.exe` 的退出码不是 agent 的退出码，agent 崩溃只能从 stderr 判断。

## 路径语义

`session/new` 的 `cwd` 是 **agent 所在世界的路径**：
WSL 是 `/home/...`，本地是 `C:\...`。`fs/*` 回调拿到的也是那一侧的路径。

v1 用 UNC（`\\wsl.localhost\<distro>\...`，实测读文件 22 ms）访问 WSL 文件，
封在 `FsProvider` 后面；`wsl.exe -- cat` 往返 130 ms，只在 UNC 语义不够时用。

9p 的符号链接语义与 Linux 不同，`canonicalize` 的前缀校验可能被绕过 —— 自己用可接受，
但要集中在一处并标注。

## 版本纪律

- `protocolVersion` 显式钉 `1`，不依赖默认值。
- v2 是 draft：`session/prompt` 只回"已受理"，进度走 `state_update`。
  crate 里它是独立 feature（`unstable_protocol_v2`），不启用。

## 实测记录（2026-10-20）

### 未知 method 不报错

`hermes acp` 收到不存在的 method 时回 `{"id":N,"result":null}`，**不是** JSON-RPC error。
所以「method 不存在会报错」不能用来探测能力 —— 能力判断只认 `initialize` 返回的
`agentCapabilities`，别靠试探调用。

### 并发请求

`session/list` 与一个不存在的 method 交错发出，两者各自拿到正确结果（`{sessions:[]}` 与 `null`），
没有串号。传输层用 pending 表按 id 配对，不要退回「读一行就当本次响应」。

### usage

- `session/update` 的 `usage_update`（`used` / `size` / `cost`）是稳定字段，hermes 实现了，
  但 `used` 是**粗估**（`estimate_request_tokens_rough`），不是计费口径。
- `PromptResponse.usage` 需要 Rust crate 的 `unstable_end_turn_token_usage` feature，
  字段是**跨轮累计**；上游没给时是 `None`（不是 0）。
- 没有 token 速率字段，也没有实时流式计数（`usage_update` 在轮次边界发）。

### session/new 的返回比协议文档写的多

实测（hermes 0.22.2）`session/new` 返回的不止 `sessionId`：

```json
{
  "sessionId": "local-<64 hex>",
  "models": { "availableModels": [...], "currentModelId": "opencode-go:deepseek-v4.1-flash" },
  "modes":  { "availableModes": [...], "currentModeId": "default" },
  "_meta":  { "hermes": { "sessionProvenance": { ... } } }
}
```

`modes` 就是权限档的来源（`default` / `accept_edits` / `dont_ask`），
`models` 是模型切换的来源 —— 这两个都是 UI 要用的，别硬编码。

## 轨迹 payload：工具调用留下什么

2026-10-24 定。此前 `tool_call` 的 payload 只有 `toolCallId / title / kind / status / locations`，
ACP 发来的 `rawInput`（命令、参数、目标）与 `content`（输出、结果）**全部丢弃** ——
轨迹面板的悬停卡片因此只能显示"跑了什么工具、什么状态"，说不出"跑的什么命令、结果如何"，
对工具调用基本没有信息增量。

### 字段

`rawInput` / `content` 原样透传（ACP 的 JSON，不改名、不扁平化）。两者都是可选的：
`tool_call_update` 是增量，可能只带其中一个，合并语义沿用 `merge_tool_call`（null 不覆盖）。

### 上限（三级）

1. **单字段 16 KB**：序列化后超限的字段替换成固定形状
   `{"__truncated": true, "bytes": N, "preview": "<前 16 KB 文本>"}`。
   形状固定是刻意的 —— 前端只认 `__truncated` 这一个标记，不去猜别的写法。
   截断点必须落在 UTF-8 字符边界上，不许把中文切成半个字节。
2. **整条 payload 64 KB**（`PAYLOAD_MAX_BYTES`）：超了按序降级 ——
   先丢 `content`，再丢 `rawInput`（都换成 `{"__truncated": true, "bytes": N}`），
   **`toolCallId / title / kind / status` 永不丢**。以前的做法是把整条 payload 换成
   `{truncated, bytes}`，那会让前端失去关联键，轨迹里出现无主条目。
3. **会话总量**：沿用轨迹 5 万条 / 90 天上限，不做额外改动。

### 不脱敏（所有者 2026-10-24）

理由记在这里，免得后来人"顺手修掉"：轨迹详情是给**使用者本人**查阅的，
对他自己隐藏自己刚才跑过的命令没有安全收益，只会制造"这行是不是被改过"的困惑。
所以不打码、不抹路径、不替换疑似令牌串。真正的秘密不该出现在命令里 ——
那属于使用者的判断，不是显示层替他做主。

## 只做基于 ACP 的扩展，不自己扩协议层（2026-10-24 定）

判断一个功能值不值得做，先问一句：**它的数据来自协议，还是来自我们自己另起的一套？**

- 协议里有的（`agentCapabilities` 的五组能力、`usage_update.used/size`、`session/new.mcpServers`、
  `session/request_permission` 的 options）→ 直接用，这是我们要补的。
- 协议里没有、要靠客户端自己探测或编造的 → **不做**。典型反例：T3 的 `session/weekly/monthly`
  额度窗口。它来自 T3 自己的 provider 额度探测层（`usageLimits.ts`），不是 ACP；
  我们照抄就得为每家 provider 写探测、要凭据（本项目不做登录态），通信链路上多出一层与协议无关的真相源。
- 唯一例外是协议自己留的口子 `_meta`：**只读、只在真出现时显示**，不替 agent 造字段。

理由写在所有者那句话里：「避免通信越来越复杂」。每加入一个自造字段，就要有人维护它对不对、
和 agent 的实现对不对得上，而这层复杂度不会随 agent 生态的演进而减少，只会越缠越死。

## 能力矩阵：能力只从握手来，不按 agent 名猜（2026-10-24 定）

`initialize` 的 `agentCapabilities` 是唯一来源。字段（schema 1.12.0）：

| 组 | 字段 |
|---|---|
| 输入 | `promptCapabilities.image` / `.audio` / `.embeddedContext` |
| 会话 | `loadSession`、`sessionCapabilities.list` / `.delete` / `.fork` / `.resume` / `.close` |
| MCP | `mcpCapabilities.http` / `.sse` / `.acp`（**不是** `mcp`） |

**会话族的每个字段只要「出现过」就算支持**（`{}` 与 `true` 同义，`null`/缺失算不支持）——
协议里它们的类型是 `Option<...Capabilities>`，`{}` 就是「支持但没有额外参数」。
真机 hermes 报的是 `{"loadSession":true,"promptCapabilities":{"image":true},
"sessionCapabilities":{"fork":{},"list":{},"resume":{}}}`：audio / embeddedContext / delete / close / MCP 全不支持。

**持久化**：握手成功后把整份能力写进 `profiles.caps_json` + `caps_at`（`ensure_column` 加列，不动
`SCHEMA_VERSION`）。没握过手就是 `null` —— 界面上说「还没连过这个 agent」，**不许**按 agent 名猜一份。

**降级策略**：某个能力不支持时，依赖它的入口**不出现**（不是置灰 —— 现有规矩是「主操作要么能点、
要么不出现」）。今天还没有按钮依赖 fork / list / delete（后端也没有这些命令），所以本期只把能力
显示出来；等真加按钮那一步再按这条规矩接。

**不要用 `mcpCapabilities` 缺失来推断「不能注入 mcpServers」**：hermes 不报这一项，但
`session/new` 的 `mcpServers` 是请求参数、由 agent 自己决定怎么用。能不能注入要在 E13.5 实测，
不能拿能力位当门。




## 远端命令行：两条红线（2026-10-24 实测）

WSL / SSH 的 agent 启动要经过 `wsl.exe` / `ssh.exe` 这一层 relay。它只做一件事：**把参数用空格拼成
一条命令行，交给远端登录 shell**。这两件事因此都不成立，踩了不会报错，只会「错得刚刚好」。

### 一、relay 进程不能被 `setsid` 顶掉

`exec setsid sh -c …` 会让 relay 被替换后立刻退出；而 `setsid` 在调用者是进程组长时会 fork、父进程返回。
relay 一退，`wsl.exe` 就认为会话结束、收掉管道 —— 我们这边看到的是
`handshake failed: agent closed stdout`（界面 50200），agent 其实起来了，只是 stdout 没人接。

**还有一个更隐蔽的入口**：`if …; then setsid …; fi` 如果就是命令行的最后一句，sh/zsh 会把它优化成
`exec`，同样顶掉 relay。实测四种写法的结果：

| 写法 | 结果 |
| --- | --- |
| `setsid echo hi` | 无输出 |
| `if …; then setsid sh -c 'echo hi'; fi` | 无输出 |
| `… fi; exit $?` | `hi` |
| `… fi; wait` | `hi` |

规矩：**setsid 前不写 `exec`，整条命令末尾补 `; exit $?`**。

### 二、脚本不能拼进命令行（引号会被吃掉）

`wsl.exe` 不做重新引用，参数里的引号过这一层就没了：

```
wsl.exe -d fedora -- bash -lc "echo '$HOME'"        →  /home/jerry
wsl.exe -d fedora -- bash -lc "sh -c 'echo $$'"     →  41556（relay 自己的 pid）
```

也就是说脚本是被 **relay 的 shell 重新解析**的：`$$`、`"$old_umask"`、`$(umask)` 全部提前展开。
后果不是启动失败，而是 pid 文件里记的是 relay：

```
pid 文件 40369 = zsh（relay）        pstree: zsh(40369)---hermes(40400)
```

`kill -TERM -40369` 只杀 relay，agent 换个会话留在机器上 —— 正是 E13.8 要根治的那类残留。

规矩：**远端脚本一律整段传输，拼进命令行的只能是 base64 或 stdin**。

- 启动脚本用 **base64 → 临时文件 → `exec bash <file>`**：base64 字母表里没有空格和引号，原样穿过这一层；
  脚本落地后由 bash 从文件读，stdin 仍然留给 ACP 的 JSON-RPC 流（不能占）
- 一次性脚本（扫描 / 回收）用 **stdin 喂 `sh -s`**，`discover.rs` 一直是这么做的
- 传输用的命令行里**不许出现** `'` `"` `$`，这是能被断言住的闸（`assert_transport_safe`）

实测对比（同一个 agent，同一台机器）：

| 传输方式 | pid 文件 | 整组 TERM 之后 |
| --- | --- | --- |
| 拼进命令行 | 40369 = zsh（relay） | agent 残留 |
| base64 → 文件 | 42560 = hermes（新会话首进程） | `SINCEARC_KILLED`，进程组 GONE |
