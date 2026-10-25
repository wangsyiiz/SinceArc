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

## 3. 配置挂在哪：软件级目录 + 连接默认 + 会话覆盖

**MCP 目录是软件的资产，不是 agent 的配置。** 这是我们做这件事的全部意义：加一个服务器只加一次，
换 agent 命令、换 profile、换会话都不用重配（T3 Code 的 `#14118` 是同一个动机：每个 account 一份
MCP 配置，加一个 Linear 就要每处重配一遍）。

但目录本身不决定「这条会话带不带」——tool schema 会被 agent 塞进上下文，带上用不到的就是白烧
token；同一个 agent 在不同会话里干不同的事，依赖的 MCP 也不同。所以是三层，每层只做一件事：

```
① 目录（全局，唯一一份）   mcp_servers 表：名字 / 类型 / 命令或 URL / env 或 headers / 默认启用
                          配置只在这里，别处一律用名字引用，不复制
② 连接默认（便捷性）       profiles.default_mcp_json —— 这个 agent 命令默认用哪几个
                          多数 agent 会想用同一套；但换 agent 也可能换一套（比如某个 agent 不吃 http）
③ 会话覆盖                 sessions.mcp_names_json —— 这条会话这次用哪几个
```

**三层同一个约定**：`NULL` = 继承上一层，`'[]'` = 明确一个都不要，数组 = 明确集合。
没有第四种含义，也没有「合并」——「合并」在界面上没法讲清楚：用户删掉一条到底是"这次不要"
还是"以后都不要"。每层都能自己说了算，就没有歧义。

```
会话生效名单 = sessions.mcp_names_json
            ?? profiles.default_mcp_json          （NULL = 继承）
            ?? 目录里 enabled = 1 的名字          （NULL = 继承）
名字 → 按目录顺序（rowid）取出配置，拼成 mcpServers 数组
```

- 名字在目录里不存在（目录删了但名单里还留着）→ **忽略该名字并 warn**，不许因此让会话建不出来。
- 顺序按目录的 rowid，不按名单顺序：同一份名单永远得到同一份报文，测试和排查都稳定。
- 界面：设置 → MCP（目录，增删改 + 默认启用开关）；连接详情 → 默认启用（多选，默认跟随目录）；
  会话详情 → 本会话（跟随连接默认 / 自定义多选 / 全部不要）。
  切到「自定义」时以当前生效名单为初值，切回跟随即丢掉自定义。


## 4. 生效时机：四个生命周期请求，改完不追溯

四个落点都注入同一份「生效清单」：

```
session/new     新建会话
session/load    恢复（会重放历史）
session/resume  恢复（不重放）
session/fork    派活 / 复制会话
```

解析顺序见 §3：会话名单 →（NULL）连接默认 →（NULL）目录里默认启用的那些 →（都没有）`[]`。

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
清单    目录上限 64 条；单次请求生效上限 32 条（超了报错，不静默截断）
         name ≤ 64 字符，目录内唯一（去首尾空白后比，存 trim 后的值）
stdio   command 必填非空；args 逐项非空；env 最多 32 项，值 ≤ 4 KB
http/sse url 必填且以 http:// 或 https:// 开头；headers 同上限
不强制  stdio.command 的绝对路径（用户常写 npx / uvx），但输入框提示规范要求绝对路径
不做    代为执行、代替 agent 管理 MCP 进程、MCP 工具的直接调用入口（协议里没有）
```

`env` / `headers` 的值**明文入库**（与「不做登录态」「轨迹不脱敏」同一条取舍）；
设置页对 value 默认掩码，点眼睛才显示。不引入系统钥匙串 —— 那是新依赖。

## 9.1 认证：不做 OAuth 客户端，走中继（2026-10-25 定）

需要浏览器授权的远程 MCP server（OAuth），我们**不实现**授权流程：不起回调服务器、不做
动态客户端注册、不存 refresh token。理由不是做不了，而是做完之后的产物只是一个会过期的
`Authorization` 头 —— 而 MCP 的连接方是 agent，刷新令牌在我们手里它也拿不到，最后变成
「每隔一小时要重建会话」的定时炸弹（T3 Code 对这件事的结论相同：*Not included yet: OAuth*）。

需要 OAuth 的服务器，用 stdio 中继挂进来：

```json
{"name": "linear", "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.linear.app/sse"]}
```

`mcp-remote` 自己起 loopback 回调（默认 `localhost`、端口按 URL 推导或显式给）、自己开浏览器、
自己缓存并刷新令牌；没有浏览器的场景还能 `--device-code`。**我们的三种形态里 stdio 一条就把
OAuth 全盖住了**，一行认证代码都不用写。

也就是说：不是不支持 OAuth，是**支持的方式是「中继」，不是「自己当授权客户端」**。
界面上对这类 server 的提示就一句：需要浏览器授权的，用 `mcp-remote` 挂成 stdio。

## 8. 验收

```
1. 合同测试（假 agent）：目录里放 3 条（stdio / http / sse），假 agent 回显收到的 mcpServers
   → 形状（stdio 无 type、http/sse 有 type）、顺序（按目录 rowid）、以及三层的 NULL/[]/数组都对
2. 真机 stdio：最小 MCP server（node，暴露一个 ping）放进目录并默认启用 → 新建会话 →
   问 hermes「调用 ping」→ 返回 pong，轨迹里能看到这次工具调用（对应 §6 第 2 条）
3. 真机 http：同一条目录里挂 http 形态 → hermes 未声明 http 也照样发出去（请求里有据可查）；
   面板上该条显示但标「agent 未声明支持」
4. 真机负例：command 指向不存在的路径 → 记录 agent 是报错还是静默（只留档，不改我们语义）
5. 三层继承：A 会话跟随（拿到 3 个）／B 会话 '[]'（拿到 0 个）／C 会话自定义 1 个（拿到 1 个）
   —— 同一连接、同一目录，三条会话的报文分别不同
```

## 9. 落点清单

```
DB       mcp_servers 表（目录，全局唯一一份）
           name TEXT PRIMARY KEY, kind TEXT CHECK IN ('stdio','http','sse'),
           config_json TEXT NOT NULL,          -- command/args/env 或 url/headers
           enabled INTEGER NOT NULL DEFAULT 1, -- 目录级「默认启用」
           created_at / updated_at INTEGER NOT NULL
         profiles.default_mcp_json TEXT NULL    -- NULL = 继承目录 enabled；'[]' = 空；数组 = 名字
         sessions.mcp_names_json TEXT NULL      -- NULL = 继承连接默认；'[]' = 空；数组 = 名字
Rust     McpServerDto（stdio 无 type、http/sse 有 type）+ 校验（§7）
         目录 CRUD：mcp_catalog() / mcp_upsert(server) / mcp_delete(name)
         session_mcp_names(ui_session_id) -> Vec<String>    三层继承（§3），坏 JSON 按空并 warn
         session_mcp_servers(ui_session_id) -> Vec<Value>   名字 → 配置（按目录 rowid 排序）
         profile_mcp_servers(profile_id) -> Vec<Value>      连接级探针（没有 UI 会话时）
         set_session_mcp_names / set_profile_default_mcp_names
         四个生命周期请求统一走它，替掉 7 处写死的 []
前端     设置 → MCP：目录列表（名字/类型/命令或 URL/默认启用开关/删除）+ 添加表单（按类型切字段）
                     + env 与 headers 的值默认掩码
         连接详情 → 「默认启用的服务器」多选，默认跟随目录
         会话详情 → MCP：跟随连接默认 / 自定义 / 全部不要 + 已注入清单 + 观察到的调用次数
         能力面板：未声明的传输在 MCP 组里标「未声明」，但仍列出已注入的条目
假 agent 回显收到的 mcpServers（合同测试用）
文档     docs/acp-notes.md 补「mcpServers 是请求参数」与「注入≠连上」
```
