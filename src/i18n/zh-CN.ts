/**
 * 中文文案：**唯一事实源**（docs/i18n.md §1）。
 *
 * key 用扁平点分名 + `keySeparator: false`：这样 `keyof typeof zhCN` 就是全量 key 的联合类型，
 * `t()` 拼错 key 直接编译报错；`en.ts` 声明成 `Record<MessageKey, string>`，少一条也编译报错。
 */
export const zhCN = {
  "language.label": "语言",
  "language.zh": "中文",
  "language.en": "English",
  "ui.button.loading": "加载中…",
  "ui.codeThemePicker.selected": "已选",
  "ui.emptyState.retry": "重试",
  "ui.field.optional": "（可空）",
  "ui.hint.ariaLabel": "{{label}} 说明",
  "ui.menu.ariaLabel": "菜单",
  "sidebar.nav.ariaLabel": "一级导航",
  "sidebar.nav.sessions": "会话",
  "sidebar.nav.code": "代码",
  "sidebar.group.today": "今天",
  "sidebar.group.yesterday": "昨天",
  "sidebar.group.earlier": "更早",
  "sidebar.projects.heading": "项目",
  "sidebar.projects.empty": "还没有项目。把本地仓库路径粘到下面添加，之后 PR 与分支都会挂在这里。",
  "sidebar.projects.placeholder": "/home/jerry/source/项目",
  "sidebar.projects.addHint": "回车添加；执行 gh 时后端把 cwd 切到这个目录",
  "sidebar.projects.add": "添加项目路径",
  "sidebar.settings": "设置",
  "sidebar.newSession": "新建会话",
  "sidebar.newSession.chooseAgent": "选择 agent 新建会话",
  "sidebar.newSession.agentHint": "选一个 agent 新建；打开后会按它自动连接",
  "statusbar.trace.expand": "展开轨迹",
  "statusbar.trace.collapse": "收起轨迹",
  "statusbar.sessionTag": "session {{id}}",
  "statusbar.sessionShort": "s:{{id}}",
  "statusbar.resume.unavailable": "续不上：{{reason}}",
  "statusbar.resume.unknownReason": "原因不明",
  "statusbar.resume.resumed": "续上（{{id}}）",
  "statusbar.resume.resumedWithNote": "续上（{{id}}） · 注意",
  "statusbar.events.short": "ev {{eventCount}}",
  "statusbar.events.shortWithLast": "ev {{eventCount}} · {{lastEvent}}",
  "statusbar.events.received": "收到的 ACP 事件：{{eventCount}}",
  "statusbar.events.last": "最后一条：{{lastEvent}}",
  "statusbar.profile.connectError": "连接失败：{{code}} {{message}}",
  "statusbar.profile.connected": "{{agent}} · 协议 v{{version}}",
  "statusbar.profile.connecting": "正在连接 agent…",
  "statusbar.profile.disconnected": "这个会话还没有连上 agent（打开会话会自动连）",
  "statusbar.profile.statusFailed": "连接失败",
  "statusbar.profile.statusConnected": "已连接",
  "statusbar.profile.statusConnecting": "连接中…",
  "statusbar.profile.statusDisconnected": "未连接",
  "emptyState.description": "一个 ACP 桌面客户端。选择左侧的 agent，在 {{cwd}} 里开始对话。",
  "emptyState.suggestion.structure": "解释一下这个仓库的目录结构",
  "emptyState.suggestion.tests": "跑一遍测试，失败的话定位原因",
  "emptyState.suggestion.cleanup": "把 acp/launch.rs 里的进程清理补上",
} as const;

/** 全量文案 key。新增文案只加在这里，再补 `en.ts`。 */
export type MessageKey = keyof typeof zhCN;
