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
  用 `setsid` 起，记 pid，退出时 `wsl.exe -d fedora -- kill -TERM <pid>`。
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
