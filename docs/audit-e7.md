# E7 审计结果（2026-10-22）

按 `dev-rules.md` §2 禁用清单全仓过一遍。**只读排查，未改任何行为。**
处理列：`立即修`（小、无风险）/ `E6`（业务计算搬迁）/ `E8`（通信或类型）/ `豁免`（写明理由）。

## A. 地基与业务混在一起（`architecture.md` §6.1）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| A1 | `src-tauri/src/db/mod.rs` `append_messages` | 在持久化层里决定**会话标题**（判定默认值「新会话」+ 截 30 字）。这是业务规则，db 只该收 title | ✅ 已修：`title_from_first_user_message()` + `DEFAULT_SESSION_TITLES` 在 commands 层；db 只提供 `set_title_if_unnamed(id, title, placeholders)` |
| A2 | `src/lib/ipc.ts` | 只有 DTO 转换与封装，未见业务判断 | 合规 |
| A3 | `src-tauri/src/acp/*` | 只做进程/协议/解析 | 合规 |
| A4 | `src-tauri/src/commands.rs` | 抽查无大段内联 SQL；模式判定集中在此（正确） | 合规 |

## B. 前端在算业务（E6）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| B1 | `Composer.tsx:16,88,103` | `estimateInput` / `parallelCost`：token 与成本按常数推算 | E6：后端给估算，或去掉提示 |
| B2 | `extensions/registry.ts:107,131` | `commandLineOf` / `previewCommand` 按 launch 拼命令，与 `acp/launch.rs` 重复 | E6：后端出「最终命令行」，前端只展示 |
| B3 | `AgentUsers.tsx:164,193,202` | 短名归一化（去 `@`）、禁空格、必填判定 —— 与后端 `50600–50602` 重复 | E6：规则只留后端，前端只翻文案 |
| B4 | `useSessionState.ts:58`、`lib/format.ts:4` | `writeLock` / `isWrite` 由前端从 activities 推导 | E6/E10：后端事件直接给「谁在写」 |
| B5 | `lib/mentions.ts` | `@` 解析（边界、最长匹配） | E6：后端提供解析；前端只管补全候选展示 |
| B6 | `useSessionList.ts:14–30` | 分组（今天/昨天/更早）用**前端本地时区**算 | 豁免（纯展示、不落库）；但「哪条算今天」应改由后端按时区给 → 记入 E6 备选 |
| B7 | `useSessionModes.ts` | 模式推值判定 | 合规：真正判定在 `session_apply_mode`，前端只调用 |

## C. 身份与并发（INV-2）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| C1 | `usePrompt.ts:64`、`App.tsx:306`、`useAcpEvents.ts:293` | 消息 id 用 `Date.now()`：同一毫秒内两次写会撞（`ON CONFLICT` 覆盖） | ✅ 已修：`lib/ids.ts` 的 `newId()`，全仓 7 处替换，附单测（5000 次不重复） |
| C2 | `useAcpEvents.ts:212` | 回答 id = `stream-<acp>-<ts>` | 合规（每轮唯一） |
| C3 | 全仓 `lastSessionId` 用法 | 复核：只用于「当前界面会话自身的操作」（发送/加载/渲染），未参与跨会话归属推导 | 合规 |

## D. 失败可见性（铁律 11）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| D1 | `usePermissions.ts:26` | `.catch(() => {})` 吞掉权限应答失败：agent 会一直等，界面无提示 | 立即修：写系统提示 + `clog` |
| D2 | `lib/log.ts:11` | 日志失败静默 | 豁免（日志失败不该影响业务） |
| D3 | 其余 `console.warn`（13 处） | 多为降级路径 | 逐个复核，涉及持久化/投递的补 `clog`（随 E8 一起） |

## E. 设计与交互规范

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| E1 | `SettingsView.tsx:606` | 原生 `<select>`（SSH 认证） | ✅ 已修：改成两段式按钮组（`role="radiogroup"`），与上方 launch 切换同一套样式 |
| E2 | `AgentCapabilities.tsx:81`、`SettingsView.tsx:177` | 弹层固定 `w-[320px]` | 豁免：宽度可固定；**位置**已贴触发元素（`top-full right-0`），符合「不飘」要求 |
| E3 | `Sidebar.tsx:33` `GROUPS` | 分组顺序常量 | 豁免（展示顺序） |
| E4 | 依赖 | `package.json` 无新增 UI 库/依赖（本轮只加 `vitest`，见 E11） | 合规 |

## F. 通信与类型（E8）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| F1 | `src/lib/ipc.ts` ↔ `commands.rs` | 事件与 DTO 两处手写，已发生漏同步 | E8.5 类型生成 |
| F2 | 全仓 `invoke("...")` | 业务代码直接调命令名 | E8.2 前端 ipc 分层 |
| F3 | `agent_message_chunk` | 前端 40ms 合批 | E8.3 合批下沉 |
| F4 | `messages_load` | 一次最多 200 条，无游标 | E8.6 分页 |

## 附：E11 测试地基（已落地，且没有新增依赖）

Node 24 原生支持 TS 类型剥离 + `node:test`，所以不需要 vitest：
`npm test` → `node --test "src/**/*.test.ts"`，当前 10 条用例全绿
（`lib/mentions.test.ts` 7 条、`lib/ids.test.ts` 3 条）。
`tsconfig.app.json` 排除 `src/**/*.test.ts`（项目没有 `@types/node`，Node 类型不该进 app 类型图）。

## 结论

- **地基污染只有 1 处**（A1），且是我昨天为修「会话同名」临时塞进去的 —— 说明 §6.1 这条规则有即时价值。
- **前端算业务 5 处**（B1–B5），全部可在 E6 里逐项搬，互不依赖。
- **两个真隐患**（C1 消息 id、D1 权限失败静默）属于「不改就会再丢数据/再卡死」，建议立刻修，不等 E6。
- **仪表盘外的发现**：`SettingsView.tsx` 已 1074 行，承载连接/成员/发现/诊断/外观五块；
  建议在 E8.2 之后拆成 `settings/` 子目录（不单独立卡，记在这里）。
