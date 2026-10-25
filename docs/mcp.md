# MCP 服务器注入（E13.5）

> 状态：合同（2026-10-25 定稿）。实现按本文落，验收按 §8。
> 上下游：`docs/acp-notes.md`（协议事实）、`docs/agents.md`（连接是什么）、`docs/architecture.md`（id 归属）。

## 1. 为什么这件事必须在客户端做

`mcpServers` 是 `session/new` / `session/load` / `session/resume` / `session/fork` 的**请求参数**，
不是 agent 的配置发现结果。agent 能连什么，取决于客户端在这一刻递了什么。**只有我们能给。**

所以我们既不做 MCP 客户端、也不管进程：stdio 的子进程由 agent 自己 spawn 并回收，
我们只负责把清单按协议形状放进请求里。

## 2. 三种形态，都不设门槛

```
stdio  {"name","command","args":[],"env":[{"name","value"}]}                      规范必选
http   {"type":"http","name","url","headers":[{"name","value"}]}                  需 mcpCapabilities.http
sse    {"type":"sse","name","url","headers":[{"name","value"}]}                   需 mcpCapabilities.sse（MCP 已弃用）
```

**通用客户端原则（不做能力倾斜）**：三种形态都实现、都允许添加、都原样发出去。

- agent 的 `mcpCapabilities` 只用于**标注**，不用于禁用、不用于拦截。
- 没有声明就发出去，agent 自己决定接不接 —— 它可能忽略、可能报错，那是它的事，我们不替它判。
- 反例（明确不做）：因为「真机 hermes 三项声明全 false」就把 http / sse 藏起来。hermes 不声明
  却三种都实现了（`acp_adapter/server.py::_register_session_mcp_servers`），按声明藏起来等于
  替用户做了一个它自己都不认的限制。

界面上：该 agent 未声明某传输时，该类型的条目仍**完整显示**，旁边标「agent 未声明支持」。
标记是信息，不是闸门。

## 3. 配置挂在哪：连接默认 + 会话覆盖

**纯连接级不行**：MCP 服务器的 tool schema 会被 agent 塞进上下文，带上用不到的就是白烧 token；
同一个 agent 在不同会话里干不同的事，依赖的 MCP 也不同。**纯会话级也不行**：每条新会话都要重配一遍。

三态存储（`sessions.mcp_servers_json`）：

| 值 | 含义 |
| --- | --- |
| `NULL` | 跟随连接默认（`profiles.mcp_servers_json`） |
| `'[]'` | 本会话**一个都不要**（显式关掉，不等于跟随） |
| `'[…]'` | 本会话自定义清单（整份替换，不与默认合并） |

整份替换而不是合并，是因为「合并」在界面上没法讲清楚：用户删掉一条默认项，到底是"这次不要"
还是"以后都不要"。三态里没有歧义。

界面（会话详情 → MCP）：单选「跟随连接默认（N 个）」/「本会话自定义（M 个）」；
切到自定义时**以当前默认清单为初值**复制一份，用户再删改；切回跟随即丢掉自定义。

## 4. 生效时机：四个生命周期请求，改完不追溯

四个落点都注入同一份「生效清单」：

```
session/new     新建会话
session/load    恢复（会重放历史）
session/resume  恢复（不重放）
session/fork    派活 / 复制会话
```

解析顺序：会话自定义 → 否则连接默认 → 否则 `[]`。

**改配置不影响已经连上的会话**：协议只在生命周期请求里传 MCP，所以改完必须再走一次
`load` / `resume` / `fork` 才生效。界面标注一句「改完不影响当前会话，重新连接后生效」，
不做后台自动重连（那会打断在飞的轮次，副作用比它解决的问题大）。

## 5. 派活子会话：用父会话的生效清单

派活 fork 的是**目标成员自己的会话**（`docs/orchestration.md §3`），但 MCP 清单取
**发起派活的父 UI 会话**的生效清单：子任务是替这个用户干的活，工具面应当与用户所在会话一致。

后果要说清：成员连接的默认清单与父会话不同时，子会话用的是父会话那份 —— 这是有意的，
不是漏了合并。

## 6. 可见性：「已注入」与「在调用」是两件事

协议里没有回执（agent 只是 SHOULD 连上），我们**不能**声称「连上了」。口径两条：

1. **注入即事实**：本次会话请求里带了 N 个（stdio a · http b · sse c），逐个列名字与类型。
   该 agent 未声明对应传输的，在类型旁标「agent 未声明支持」。
2. **在调用要证据**：观察到 `toolCall` 属于 MCP 工具时，补一行「已观察到 MCP 工具调用 N 次」。
   MCP 工具名有特征（`mcp__<server>__<tool>` 这类前缀，或 agent 给的 toolset 名），按形状判，
   不按 agent 名判；判不出来就只显示第 1 条，不猜。

轨迹里不新增事件类型：MCP 工具调用走现有 `toolCall`，`kind` 保持 agent 给的值。

## 7. 校验与边界

```
清单    单会话 / 单连接上限 32 个；name ≤ 64 字符，清单内唯一（去首尾空白后比）
stdio   command 必填非空；args 逐项非空；env 最多 32 项，值 ≤ 4 KB
http/sse url 必填且以 http:// 或 https:// 开头；headers 同上限
不强制  stdio.command 的绝对路径（用户常写 npx / uvx），但输入框提示规范要求绝对路径
不做    代为执行、代替 agent 管理 MCP 进程、MCP 工具的直接调用入口（协议里没有）
```

`env` / `headers` 的值**明文入库**（与「不做登录态」「轨迹不脱敏」同一条取舍）；
设置页对 value 默认掩码，点眼睛才显示。不引入系统钥匙串 —— 那是新依赖。

## 8. 验收

```
1. 合同测试（假 agent）：会话里配 3 条（stdio / http / sse），假 agent 回显收到的 mcpServers
   → 形状、顺序、三态（NULL / [] / 自定义）都对
2. 真机 stdio：最小 MCP server（node，暴露一个 ping）挂进连接默认 → 新建会话 →
   问 hermes「调用 ping」→ 返回 pong，轨迹里能看到这次工具调用（对应 §6 第 2 条）
3. 真机 http/sse 标注：hermes 未声明 http/sse → 面板里该条仍显示，标「agent 未声明支持」；
   请求里确实带着它（日志或假 agent 侧证据）
4. 真机负例：command 指向不存在的路径 → 记录 agent 是报错还是静默（只留档，不改我们语义）
5. 会话覆盖：同一连接下 A 会話自定义 1 个、B 会话跟随默认 3 个 → 两条会话的请求里分别是 1 和 3
```

## 9. 落点清单

```
DB       profiles.mcp_servers_json TEXT NOT NULL DEFAULT '[]'
         sessions.mcp_servers_json TEXT NULL            -- NULL = 跟随连接默认
Rust     McpServerDto（tagged：stdio / http / sse）+ 校验（§7）
         session_mcp_servers(ui_session_id) -> Vec<Value>  一个函数解析三态，替掉 7 处写死的 []
         profile_mcp_servers(profile_id) -> Vec<Value>      给「新建会话前没有会话」的路径用
         四个生命周期请求统一走它
前端     设置 → 连接详情内「MCP 服务器」块：列表 + 增删 + 类型切换 + 掩码后的 env/headers
         会话详情 → MCP：跟随默认 / 本会话自定义（三态）+ 已注入清单 + 观察到的调用次数
         能力面板：未声明的传输在 MCP 组里标「未声明」，但仍列出已注入的条目
假 agent 回显收到的 mcpServers（合同测试用）
文档     docs/acp-notes.md 补「mcpServers 是请求参数」与「注入≠连上」
```
