# 会话审批模式（文件编辑审批）规范

> 状态：已拍板（2026-10-21）。本文件是 E3 的前置规范，代码实现以此为准。
> 一句话：**客户端是审批模式的唯一真相源**；连接上配默认，会话上可覆盖，每次打开会话都把值推给 agent。

## 1. 它到底管什么

管**文件编辑**的自动批准。不管命令执行 —— 命令走 `session/request_permission` 逐条询问，
那是另一条链路，不在本规范范围内。

这是 agent 实现的边界，不是我们可以改的：hermes 的 mode 只接到
`_edit_approval_policy_for_state → should_auto_approve_edit`（`acp_adapter/edit_approval.py`），
命令审批不读 mode。

推论（UI 必须写清，否则用户会认为设置没生效）：

- 设成「本会话不问」之后，改文件不弹卡了，但跑命令仍然逐条弹
- 敏感路径（agent 自身指令文件等）**永远**询问，任何模式都放不过去

## 2. 协议依据

- 会话模式是 ACP 正式定义：session 建立/恢复的响应里带 `modes{currentModeId, availableModes[]}`，
  切换用 `session/set_mode`，agent 自己改会发 `current_mode_update` 通知
- `session/set_mode` 是**会话级内存态**：agent 侧不持久化它，断连即丢。这正是不依赖它、由客户端推值的原因
- ACP 已标注 modes 未来会被 `session/config_options` 取代（`category: "mode"`）。
  本规范只约定「这个会话的文件编辑审批模式」这一语义，不约定读写通道；实现按
  **configOptions 优先、无则回落 modes** 写

实测（2026-10-21，hermes-agent 0.22.2 / protocolVersion 1）：

| 步骤 | 结果 |
| --- | --- |
| `session/new` | 返回 3 档：default / accept_edits / dont_ask，`currentModeId=default` |
| `session/set_mode` → dont_ask | 成功 |
| `session/load` 读回 | `currentModeId=dont_ask`，证明推值生效且可读回校验 |
| `set_mode` 传不存在的 id | 报错 `-32603 INTERNAL_ERROR`（`data.details=invalid_params`），原值不变 |

## 3. 数据模型

```
profiles.default_mode   TEXT NULL   -- 连接的默认模式；NULL = 不推，尊重 agent 自己的默认
sessions.mode_override  TEXT NULL   -- 会话覆盖值；NULL = 跟随连接默认
```

- 存的是**用户意图**，不是实际生效值。实际生效值每次打开会话时按 §4 推算
- NULL 与「显式设成和默认一样的值」是两个不同状态，都必须能表达：
  前者会被默认值变化影响，后者不会
- `mode_override` **不做归一化**：即便用户选的值恰好等于连接默认，也照样存。
  归一化会把「我要这个会话固定成 X」悄悄改写成「跟随默认」，改默认时它就跟着变，与用户意图相反

## 4. 生效规则（唯一判据，兜底写在最后）

```
target = sessions.mode_override ?? profiles.default_mode
```

1. `target` 为 NULL → **不发送 set_mode**，沿用 agent 打开会话时报告的 `currentModeId`
2. `target` 不在本次会话的 `availableModes` 里 → **不发送**，记一条诊断，界面把选择器标成
   「该连接不支持此模式」，并保留用户的设置值（不擅自改成 default）
3. 其余情况 → 发送 `session/set_mode`

**兜底：以上三条都没命中、或 `availableModes` 缺失/为空时，一律按「不推」处理**（规则 1 的语义），
并在诊断里留一行，不得静默猜测一个值推上去。

## 5. 应用时机

| 时机 | 是否推给 agent | 是否写 `mode_override` |
| --- | --- | --- |
| `session/new` 返回后 | 推（按 §4） | 否 |
| `session/load`（重连/恢复）返回后 | 推（按 §4） | 否 |
| UI 切标签、切会话页（不重连 agent） | 否 | 否 |
| **用户在会话内从下拉里选了一个模式** | 推所选值 | **是（甲案）** |
| agent 发 `current_mode_update` | 否（agent 已经切好了） | 否，只更新界面显示 |

判据只有一条：**谁发起的**。用户在下拉里选 → 显式意图，落存储；agent 自己切
（例如通过 switch_mode 工具退出计划模式）→ 临时事实，只更新显示，不落存储。

### 5.1 用户手切的写入顺序

1. 先校验所选值 ∈ 本次会话的 `availableModes`，不在 → 报错并中止，不写存储（§4 规则 2）
2. 发送 `session/set_mode`
3. **成功之后**才写 `sessions.mode_override`；失败则保留原值、报错、不写存储（§6）

不允许「先落库再切」：那样 agent 拒绝时，存储里会留下一个从未生效过的值，下次打开还会再失败一次。

### 5.2 界面状态

选择器只有两个状态，必须能分辨，不能只显示当前值：

- **跟随连接**（`mode_override IS NULL`）—— 显示 `default_mode` 生效后的值，注明「跟随连接默认」
- **手动**（`mode_override` 非 NULL）—— 显示覆盖值，并提供「改回跟随连接」的动作（置 NULL）

`default_mode` 也为 NULL 时，「跟随连接」显示的应是 agent 报告的 `currentModeId`，文案「跟随 agent 默认」。

### 5.3 接受的一条副作用

**每次打开会话都会按存储值重新应用**。因此：agent 在会话内自己切的模式，关掉重开后回到存储值；
用户手切但 `set_mode` 失败时，也仍是旧值。这条要写进设置页说明文案 —— 它是「客户端权威」的必有代价。

## 6. 失败处理（显式报错，不静默降级）

- `set_mode` 返回错误 → 保留原值（实测证明 agent 不会改动原值），不重试，不写 `mode_override`
- 错误码 `-32603 INTERNAL_ERROR` + `data.details=invalid_params` → 翻译成用户可读的
  「这个连接不支持模式 X」，不要把 JSON-RPC 错误码原样甩给用户
- 校验失败（§4 规则 2 / §5.1 第 1 步）与应用失败（本节）在界面上要能区分：
  前者是配置问题，后者是运行期问题

## 7. 明确不做

- 不接线 `permission_rules` / `workspaces`（保持 E4 预留状态）。本规范不引入任何按路径匹配的规则表
- 不做「项目永久信任」。mode 生效范围是会话 + agent 侧开关，关掉应用不构成任何持久信任
- 不改命令执行的审批行为

## 8. 验收用例（真机）

1. 连接默认 = dont_ask，新建会话 → 改文件不弹卡；同会话里跑命令 → 仍弹卡
2. 连接默认 = dont_ask，某会话覆盖 = default → 该会话改文件仍弹卡，其他会话不受影响
3. 把 `mode_override` 人为写成不存在的 id → 界面显示「不支持」+ 诊断有一行，agent 侧仍是原模式
4. 断开重连同一会话 → 覆盖值仍生效（证明是我们推上去的，不是 agent 记住的）
5. `mode_override` 与 `default_mode` 都为 NULL → 不发 set_mode（抓包/日志确认）
6. 会话内手切到 dont_ask → 关掉应用重开该会话，仍是 dont_ask（override 已落库）
7. 会话内切到连接不支持的 id（人为构造）→ 报错、`mode_override` 保持原值不变
8. 会话内手切后，agent 再发 `current_mode_update` → 界面跟随 agent，存储值不变
