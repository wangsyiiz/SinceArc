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
① 目录（全局，唯一一份）   mcp_servers 表：名字 / 类型 / 命令或 URL / env 或 headers
                          配置只在这里，别处一律用名字引用，不复制
                          **目录条目本身没有「启用/禁用」** —— 它是一份清单，不是一个开关面板
② 连接默认（便捷性）       profiles.default_mcp_json —— 这个 agent 命令默认用哪几个
                          多数 agent 会想用同一套；但换 agent 也可能换一套（比如某个 agent 不吃 http）
③ 会话覆盖                 sessions.mcp_names_json —— 这条会话这次用哪几个
```

**唯一的全局开关是「新建连接默认继承这份目录」**（settings 键 `mcp_inherit_default`，默认开）：

- 开：新建连接时 `default_mcp_json = NULL`（= 继承目录全部）；
- 关：新建连接时 `default_mcp_json = '[]'`（= 一个都不要），用户再自己挑。

它只决定**新建连接那一刻的初值**，改开关不会回头改已有连接 —— 已有连接的名单是它自己的选择。

**三层同一个约定**：`NULL` = 继承上一层，`'[]'` = 明确一个都不要，数组 = 明确集合。
没有第四种含义，也没有「合并」——「合并」在界面上没法讲清楚：用户删掉一条到底是"这次不要"
还是"以后都不要"。每层都能自己说了算，就没有歧义。

```
会话生效名单 = sessions.mcp_names_json
            ?? profiles.default_mcp_json          （NULL = 继承）
            ?? 目录里的全部名字                    （NULL = 继承）
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

**这条在 agent 侧还有第二个坎**（见 §11.2）：MCP 工具登记在 agent **进程**的工具面上，
某个会话登记过之后，同进程里所有会话都看得见，空名单不会注销。所以「减少」要真正生效，
光重新 `load` 不够 —— 得让 agent 换一个进程。界面上要和「新增」分开讲。

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
DB       mcp_servers 表（目录，全局唯一一份；**没有 enabled 列**）
           name TEXT PRIMARY KEY, kind TEXT CHECK IN ('stdio','http','sse'),
           config_json TEXT NOT NULL,          -- command/args/env 或 url/headers
           created_at / updated_at INTEGER NOT NULL
         settings 键 mcp_inherit_default（bool，默认 true）—— 新建连接是否继承整份目录
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
         会话级入口：输入区底部工具行、「自动同意」控件**左侧**的一枚芯片
                     （「MCP · <已注入数>」）→ 点击向上展开面板：
                     跟随连接默认 / 自定义 / 全部不要 + 已注入清单 + 变动后的「重连以生效」
                     （顶部能力面板只显示能力支持情况，不放任何会话 MCP 内容）
         能力面板：未声明的传输在 MCP 组里标「未声明」，但仍列出已注入的条目
假 agent 回显收到的 mcpServers（合同测试用）
前端     类型陷阱：`McpServerDto` 的 serde 是手写的（stdio 无 type），ts-rs 却按默认枚举收成
         `{ Stdio: {...} }` 这种带外壳的联合，和线上形状不一致。界面一律走
         `src/lib/mcp-display.ts::serverFields()` 归一化，不要按生成的声明直接读字段。
文档     docs/acp-notes.md 补「mcpServers 是请求参数」与「注入≠连上」
```

## 10. 认证：不做 OAuth 客户端，走中继（2026-10-25 定）

需要浏览器授权的远程 MCP server（OAuth），我们**不实现**授权流程：不起回调服务器、不做
动态客户端注册、不存 refresh token。理由不是做不了，而是做完之后的产物只是一个会过期的
`Authorization` 头 —— 而 MCP 的连接方是 agent，刷新令牌在我们手里它也拿不到，最后变成
「每隔一小时要重建会话」的定时炸弹（T3 Code 对这件事的结论相同：*Not included yet: OAuth*）。

需要 OAuth 的服务器，用 stdio 中继挂进来：

```json
{"name": "linear", "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.linear.app/sse"]}
```

`mcp-remote` 自己起 loopback 回调（默认 `localhost`、端口按 URL 推导或显式给）、自己开浏览器、
自己缓存并刷新令牌；没有浏览器的场景还能 `--device-code`。**三种形态里 stdio 一条就把 OAuth
全盖住了**，一行认证代码都不用写。

也就是说：不是不支持 OAuth，是**支持的方式是「中继」，不是「自己当授权客户端」**。

### 10.1 认证一次就够，跨 agent 复用

令牌由 `mcp-remote` 按**服务器 URL 的哈希**缓存在本机用户目录，不属于任何 agent：

```
~/.mcp-auth/{server_hash}_tokens.json        access / refresh token
~/.mcp-auth/{server_hash}_client_info.json   它自己注册的 client 信息
```

所以第一个 agent 弹一次浏览器授权，令牌落到这个文件；之后任何 agent spawn 中继都直接读它，
**不再弹窗**，续期也在文件里滚动 —— 换 agent 完全不用重来。这就是「集中配置」在认证上的
自然结果，虽然实现方式是把它外包给一个进程。

会再认证一次的情形，全都与 agent 无关：

```
换机器 / 换 OS 用户   令牌在 home 里。profile 可跑在 local / WSL / SSH 三种位置，那就是三份 home，
                      各认证一次（WSL 的 home 与 Windows 的不是同一份）
URL 变了              /sse 换成 /mcp、换域名或路径 → 哈希不同 → 算另一台服务器，再来一次
缓存被清              官方排障手段就是 rm -rf ~/.mcp-auth
两个 agent 同时首次   都没缓存时会各弹一次，谁先点完就有了；之后无提示
```

**一条真实局限，必须写下来**：令牌按 URL 哈希存，所以**同一个 URL 只能对应一个账号**。
想同时登个人与公司两个同类账号，改名没用（名字不参与哈希），两个条目会共用同一份令牌。
真要两个账号，得让服务器侧给出不同 URL（如带 `?account=` 的地址），或让中继分目录存 ——
这是中继模式的边界，不是我们的实现问题。

中继 vs 自建 OAuth 的取舍摊平：

## 11. 实测：agent 侧的三件事（2026-10-25，hermes 真机）

这三条不是推断，是跑出来的，直接决定界面话该怎么说。

### 11.1 「未声明」不等于「不支持」

hermes 的 `mcpCapabilities` 三项（http / sse / acp）都没声明，我们的解析里全是 false。
但它三种传输都实现了（`acp_adapter/server.py::_register_session_mcp_servers` 收
`McpServerStdio | McpServerHttp | McpServerSse`）。

实测：目录里同时放 stdio（`ping`）与 http（`pinghttp`），连接默认启用两条 → hermes 两个都连上了，
轨迹里两次调用：

```
mcp__editor_ping_5cffc61d__ping         ← stdio
mcp__editor_pinghttp_fa52a681__ping     ← http（未声明 http 能力，照样连上）
返回都是 {"result": "pong"}
http fixture 侧收到 initialize / tools/list / tools/call
```

⇒ §2 的「只标注、不拦截」不是保守，是**按实测**：按声明拦截会挡掉真实能力。

### 11.2 MCP 登记是进程级的：空名单注销不掉

**先分清这是不是协议要求 —— 不是。** ACP 只规定 `mcpServers` 是 `session/new|load|resume|fork`
的请求参数（"A list of MCP servers the Agent should connect to"），并说 "Agents **SHOULD** connect
to all MCP servers specified by the Client"；**作用域、注销时机、工具面归谁，协议一句都没写**。
`session/close` 那句「释放与该会话相关的资源」也没把 MCP 单独拎出来。

所以「per-session 隔离」是 agent 的实现选择，不是协议义务。同一个协议位允许两种做法：

```
按会话隔离   会话结束 / 名单变化就把该会话的 server 摘掉（客户端改名单立刻生效）
进程级共享   进程里登记一次，所有会话都能用（hermes 现在这样；工具面属于进程，不属于会话）
```

hermes 属于后者，它不违约。代价才落到我们这边：**我们能保证的只有「发出去的是什么」和「如实显示」**，
保证不了 agent 按会话隔离。

#### 当前处理（本批就停在这里）

会话级名单**变少**时（删项，或切到「全部不要」），界面给一句事实 + 一个动作：

```
该 agent 的 MCP 工具登记在进程上，减少不会自动注销，要重新连接才可能生效。
[ 重连以生效 ]        ← 用户点了才 agent_disconnect + 重新连接；不自动断，不弹系统提示
```

名单**变多或不变**时不提示、不给按钮 —— 增加跟着下一次 `new` / `load` 就生效，提示只会变成噪音。

#### 未决：用观测代替猜测（不在本批）

可以做但先不做的一条：**若某会话的生效名单为空、却在该会话里观察到 MCP 工具调用**（`mcp__` 前缀的
`toolCall`），就在会话面板标一行「该 agent 的 MCP 按进程共享」。证据来自已有事件，不额外造状态。

不现在做的理由：它只覆盖「空名单却调到工具」这一种形状，判断不出「名单里有的其实没连上」；
一条半覆盖的标注容易让人以为我们在保证隔离性。等真的有人被它绊到（或 agent 侧改成按会话隔离）再看。


hermes 把注入的 server 注册在**进程**的工具面上（`register_mcp_servers(configs)` 是进程全局），
`session/load` 里空名单还被显式当成「保留这个会话原有的服务器」（源码注释：
*An empty one (load always carries a list) keeps the session's servers*）。

实测，同一进程里：

```
先让某会话注入 ["ping","pinghttp"]            → 它调得到两个 ping 工具
再把另一个新会话的名单设成 [] 并发第一条消息   → 仍然回答「有」（工具是进程级的）
断开连接（杀掉进程）+ 名单 [] + 重发          → 回答「没有」
```

⇒ 会话级的「**增加**」跟着下一次 `load` / `new` 就生效；「**减少**」要等 agent 换进程。
我们不替 agent 自动重启（会打断别人的在飞轮次），界面上把两种改动分开说。

### 11.3 工具名形状（给 §6 第 2 条用）

hermes 的 MCP 工具名是 `mcp__editor_<server>_<hash>__<tool>`，其余 agent 也多是 `mcp__` 前缀。
判据按形状（`mcp__` 开头且中段是目录里的 server 名）而不是按 agent 名 —— 认不出来就只显示「已注入」。

## 12. 中继 vs 自建 OAuth：摊平

```
中继    一次认证、跨 agent 复用、续期撤销都归它，我们零认证代码
        代价① 每个 agent 各 spawn 一个中继进程（n 个 agent = n 个常驻 node 进程）
        代价② 令牌不在我们库里 → 界面只能说「已注入」，无法显示「已授权 / 需重新授权」
              （要显示就得去读 ~/.mcp-auth，那是别人内部实现的细节，不做）
自建    token 进我们的库、UI 能显示授权状态，但发现 / DCR / 续期 / 撤销全要自己维护
```
