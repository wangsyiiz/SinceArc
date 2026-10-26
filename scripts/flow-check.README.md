# E17 · d 端到端流程脚本

状态：**未运行，待主会话执行**。本目录只新增了脚本与这份报告，没有改产品代码、`docs/`，也没有 commit。

## 文件清单

- `scripts/flow-check.mjs`：一条命令跑完 normal / cancel / reopen / permission / late-text，断言本地库不变量与 DOM 数值。
- `scripts/flow-check.README.md`：用法、断言键名、选择器边界与未完成项。

## 用法

在 Windows 侧用 Node 24（需要有全局 `fetch` 与 `WebSocket`）执行：

```powershell
node scripts/flow-check.mjs
node scripts/flow-check.mjs --cdp http://127.0.0.1:9222
node scripts/flow-check.mjs --db C:\Users\<user>\AppData\Roaming\com.sincearc.app\sincearc.db
node scripts/flow-check.mjs --sqlite3 C:\software\platform-tools\sqlite3.exe
node scripts/flow-check.mjs --only normal,cancel,reopen
```

参数默认值：

- `--cdp`：`http://127.0.0.1:9222`
- `--db`：`%APPDATA%\com.sincearc.app\sincearc.db`（即 `C:\Users\<user>\AppData\Roaming\com.sincearc.app\sincearc.db`）
- `--sqlite3`：`C:\software\platform-tools\sqlite3.exe`
- `--only`：不传时按 `normal,cancel,reopen,permission,late-text` 顺序全跑
- `--with-permission`：默认不传，permission 输出已知缺口的 SKIP；传入后启用真机权限断言接口
- `--permission-prompt <text>`：`--with-permission` 时发送的 prompt，默认「请修改当前目录下的一个文件（先请求我的确认）」

等待与退出码：

- agent / 轮次 / 权限等待默认 `180s`；DOM 本地动作等待 `30s`；单次 sqlite3 查询 `15s`。
- 一个 flow 失败不会阻断后续 flow。
- 有 `FAIL` 时退出码为 `1`；全部 PASS 或 SKIP 时为 `0`；参数错误为 `2`。

## 断言键

### normal

- `a_dom_messages`：该 `turn_id` 的 DOM 消息至少 2 条，且至少有 1 条 agent 正文（`.sc-prose`）。
- `b_db_atoms`：`text.user` 恰好 1 条、`text.agent` 至少 1 条、`channel='trace' AND kind='usage'` 至少 1 条。
- `c_turn_sealed`：`turns.status='finished'`，且该轮没有 `sealed_at IS NULL` 的原子。

### cancel

先等 agent 真的吐出内容（≥ 40 字，最多等 90s）再点停止 —— 否则停止可能落在第一个分片之前，
验的只是「空转取消」。没等到内容即判 FAIL，但**仍会点停止**把这一轮收尾，避免留 running 轮污染后续 flow。

- `a_stream_started`：停止前 agent 文本已达 40 字（`agent_text_len`）。
- `b_turn_cancelled`：`turns.status='finished'` 且 `stop_reason='cancelled'`。
- `c_all_atoms_sealed`：该轮 `sealed_at IS NULL` 的原子数为 0。
- `d_no_send_failure`：当前 `main` 里没有可见「发送失败」，也没有 `title` 含「发送失败」的节点。

### reopen

- `a_message_count`：切走再切回后，`[data-message-id]` 数量与切走前一致。
- `b_message_order`：切回后每条消息的 `data-message-id` 与 `data-turn-id` 按顺序逐一相同。
- `c_db_atoms_unchanged`：该会话 `atoms` 总数与切走前一致；会话 id 优先由当前可见 `turn_id` 反查 `turns.session_id`。

### permission

默认输出：

```text
SKIP  permission  真机 agent 不发起权限请求（映射与单测已覆盖）
```

`--with-permission` 时：

- `a_permission_dialog`：PermissionDialog 出现，带可点的「允许」按钮，且该轮进入 `waiting_approval`。
- `b_permission_allowed`：点击允许后对话框关闭，库里该轮出现 `permission_decision` 且 `payload_json.verdict='allow'`。
- `c_turn_resumed`：轮次恢复到 `finished`，且没有未封口原子。

### late-text

先创建一轮短对话，轮次进入终态后观察 `3s`：

- 若出现新的 agent 文本原子，或该轮 agent 正文继续增长：`late_text_sealed` 要求迟到原子（或正文增长后的最后一条 agent 原子）`sealed_at` 非空。
- 若没有迟到文本：不判失败，输出 `SKIP  late-text  本轮没有触发迟到窗口`。

### 全局 I1

每个 flow 结束（包括 SKIP 与异常）后都执行：

```sql
SELECT count(*) FROM atoms a JOIN turns t ON t.id = a.turn_id
 WHERE a.sealed_at IS NULL AND t.status NOT IN ('running','waiting_approval');
```

结果大于 0 时该 flow 直接 FAIL；I1 不额外占用 flow 自己的 `checks` 计数。

## 选择器与实现边界

- 输入用唯一的可见 `textarea`，并通过原生 `HTMLTextAreaElement.prototype.value` setter + `input` 事件触发 React 受控更新。
- 新建会话按侧栏按钮文字「新建会话」定位；发送 / 停止 / 允许分别按 `aria-label` 含「发送」、`aria-label` 含「停止」、按钮文字含「允许」定位。
- 侧栏没有 `data-session-id`。`reopen` 的选中态依赖 `aside .sc-row-active`，行标题来自 `span.truncate.text-small`；切回时先按原索引，索引/标题不匹配再按标题查找。
- 当前会话 id 优先从 DOM 最后一个非空 `[data-turn-id]` 反查数据库。只有在没有可见 turn 时，才退化为「侧栏标题 + cwd」匹配 `sessions`；同名会话无法唯一确定时会明确失败，而不是猜一个 id。
- 数据库只执行 `sqlite3 -json <db> <sql>` 查询；脚本本身不直接写库，写操作都来自被测 UI / agent。

## 没做或做不了的地方

- 未运行脚本，未连接应用、未调用 agent、未查询真实库；这里没有「已验证通过」的结论。
- 没有截图、读图、像素比较或任何视觉判断。
- permission 默认只验证已知缺口并 SKIP。`--with-permission` 只留了完整接口；真机 hermes 当前不会发 `session/request_permission`，环境不支持时传入该参数会在等待超时后 FAIL。
- late-text 只能观察 DOM 文本变化和库里的新原子，无法直接监听 agent 事件流；未触发 3s 窗口时按约定 SKIP。
- reopen 依赖侧栏文字与 Tailwind class 选择器。若产品改动侧栏结构、标题 class 或 `sc-row-active`，脚本会以明确错误失败，需要同步选择器；同名同 cwd 会话且当前视图没有 turn 时无法唯一定位。
- 多次查询之间没有跨查询快照；若切会话期间后台恰好写入新原子，`reopen.c_db_atoms_unchanged` 会如实报变化。
