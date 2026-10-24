# 验证客户端 `fs/read_text_file` 沙箱

## 这份 runbook 验证什么

它验证 SinceArc 在收到 agent 发来的 `fs/read_text_file` 请求后，能按该会话的 `cwd`
读取子树内文件，并拒绝绝对路径越界与 `..` 越界。

它**不验证**：

- agent 自带文件工具（如 hermes / codex 的 `read_file`）会被限制；
- 进程级隔离（bwrap / Job Object / 容器）；
- 写文件与终端能力。

原因见 `docs/architecture.md` §7.1：真实 agent 可能根本不走客户端 fs 通道。
本 runbook 用一个假 ACP agent 强制走这条通道，因此结果是确定的。

## 准备

1. 选一个专用目录，例如：

   ```text
   C:\Users\<你的用户名>\sincearc-fs-check
   ```

   在其中创建 `inside.txt`，内容随意，例如：

   ```text
   hello from fake agent
   ```

2. 确认 Windows 侧 Node 可用（`node.exe` 版本不限，脚本无第三方依赖）。

## 在 SinceArc 里运行

1. 打开设置页，新建连接：
   - `program`：`C:\Program Files\nodejs\node.exe`
   - `args`：`C:\source\sincearc\scripts\fake-acp-agent.mjs`
     （按你本机仓库实际路径替换）
   - `cwd`：第一步创建的目录，例如 `C:\Users\<你的用户名>\sincearc-fs-check`
2. 连接该 profile。
3. 新建会话，发送任意一条消息。

假 agent 收到 `session/prompt` 后会先发出三条客户端请求，再等三份响应：

- `inside.txt`
- `C:\Windows\win.ini`
- `../escape.txt`

全部结束后才会回 `prompt` 的 `end_turn`。

## 检查结果

打开 cwd 下的 `fake-agent-report.json`。应满足：

- `checks[0]`：`id: 100`、`path: "inside.txt"`、`ok: true`，`preview` 是
  `inside.txt` 的内容；
- `checks[1]`：`id: 101`、`ok: false`、`code: -32602`，`message` 含「越界」；
- `checks[2]`：`id: 102`、`ok: false`、`code: -32602`，`message` 含「越界」。

示例形状（`bytes` / `preview` 随 `inside.txt` 内容变化）：

```json
{
  "cwd": "C:\\Users\\picke\\sincearc-fs-check",
  "checks": [
    {
      "id": 100,
      "path": "inside.txt",
      "ok": true,
      "bytes": 21,
      "preview": "hello from fake agent"
    },
    {
      "id": 101,
      "path": "C:\\Windows\\win.ini",
      "ok": false,
      "code": -32602,
      "message": "路径越界"
    },
    {
      "id": 102,
      "path": "../escape.txt",
      "ok": false,
      "code": -32602,
      "message": "路径越界: ../escape.txt"
    }
  ]
}
```

如果结果不符，附上以下材料排查：

1. 上面的 `fake-agent-report.json`；
2. `%APPDATA%\com.sincearc.app\sincearc.log` 中三条 `fs/read_text_file` 记录
   （一条 `ok`，两条 `rejected`）。如果没有该日志，改附应用启动终端的 stderr。

假 agent 会在 `session/new` 后切到会话 cwd，并打印 `cwd -> ...`。找不到报告时先看这行；
若 cwd 为空或相对路径，报告会落在 agent 启动目录，且客户端 fs 校验也会拒绝读取。

## 判定

- 三条都符合：客户端 fs 路由与 cwd 沙箱正常。
- `inside.txt` 也失败：先看报告里的 `code` / `message`，常见是 cwd 配置成了相对路径、
  目录不可读，或连错了 profile。
- 两条越界请求返回 `ok: true`：这是安全回归，停止使用并保留报告与日志。

## 权限请求自测（自动同意 E13.6b）

同一个假 agent 也能发 `session/request_permission`。开关是**会话 cwd 下的
`fake-permission.json`**，每次提问前现读，所以改完不用重启客户端，只要再发一条消息：

```json
{"kind": "edit", "options": "allow_reject", "timeoutMs": 20000}
```

- `kind`：`edit` / `delete` / `move` / `execute` / `read` / `unknown`（`unknown` = 不带 kind）。
- `options`：`allow_reject`（默认，给"允许一次/总是允许/拒绝"）或 `reject_only`（只给拒绝）。
- `timeoutMs`：假 agent 等应答的上限，默认 5000；要手点时放长到 20000。

四种场景的期望（输入区 chip 记得先切到「自动同意 · 编辑」）：

| 场景 | kind | options | 期望 |
| --- | --- | --- | --- |
| 自动放行 | `edit` | `allow_reject` | 不弹窗；轨迹里 1 轮 2 动作，最后一条「自动批准 · 编辑文件 / 允许一次」 |
| 类型不覆盖 | `execute` | `allow_reject` | 弹窗，chip「执行命令」，带「这条没法自动同意」 |
| 没有可放行选项 | `edit` | `reject_only` | 弹窗，只有「拒绝」，带「这条没法自动同意」 |
| 未分类 | `unknown` | `allow_reject` | 弹窗，chip「未分类」，带「未分类，需要你决定」 |

核对落库（客户端关掉后读，或对副本读）：`session_events` 里同一 `turn_id` 下应有
`permission` + `permission_decision` 两条，后者 payload 形如
`{"verdict":"allow","optionId":"allow_once","via":"auto:edits",...}`；
手动点的则是 `"via":"user"`。假 agent 侧的真实应答记在 `fake-agent-report.json` 的
`permission.outcome`（`{"outcome":"selected","optionId":"allow_once"}`，自动放行约 20ms）。
