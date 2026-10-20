import type {
  Activity,
  AgentProfile,
  GithubPR,
  GithubRepo,
  Message,
  PermissionRequest,
  Player,
  SessionSummary,
  TraceTurn,
} from "@/types";

export const profiles: AgentProfile[] = [
  {
    id: "p-hermes-wsl",
    name: "Hermes (WSL)",
    launch: "wsl",
    detail: "fedora · hermes acp",
    connected: true,
    agentName: "hermes-agent 0.22.2",
    protocolVersion: 1,
  },
  {
    id: "p-local-mock",
    name: "本地 Mock",
    launch: "local",
    detail: "C:\\source\\mock-acp.exe",
    connected: false,
    agentName: null,
    protocolVersion: null,
  },
  {
    id: "p-ssh-aliyun",
    name: "Aliyun",
    launch: "ssh",
    detail: "root@47.109.56.213 · hermes acp",
    connected: true,
    agentName: "hermes-agent 0.22.2",
    protocolVersion: 1,
    cwd: "/root/src/demo",
    ssh: { host: "47.109.56.213", port: 22, user: "root", auth: "key", keyPath: "C:\\Users\\picke\\.ssh\\id_ed25519" },
  },
];

export const players: Player[] = [
  { id: "pl-claude", name: "Claude", handle: "claude", color: "#c0a3ff", profileId: "p-hermes-wsl", busy: true },
  { id: "pl-hermes", name: "Hermes", handle: "hermes", color: "#6fe0c9", profileId: "p-hermes-wsl", busy: false },
  { id: "pl-codex", name: "Codex", handle: "codex", color: "#f0b46a", profileId: "p-local-mock", busy: false },
];

export const sessions: SessionSummary[] = [
  {
    id: "s-1",
    title: "给 SinceArc 加会话侧栏",
    cwd: "/home/jerry/source/sincearc",
    updatedAt: "刚刚",
    group: "今天",
    playerIds: ["pl-claude", "pl-hermes"],
  },
  {
    id: "s-2",
    title: "ACP 流式渲染的合批策略",
    cwd: "/home/jerry/source/sincearc",
    updatedAt: "12 分钟前",
    group: "今天",
    playerIds: ["pl-hermes"],
  },
  {
    id: "s-3",
    title: "fs/read_text_file 的沙箱校验",
    cwd: "/home/jerry/source/sincearc/src-tauri",
    updatedAt: "昨天",
    group: "昨天",
    playerIds: ["pl-claude", "pl-codex"],
  },
  {
    id: "s-4",
    title: "Tauri 打包体积对比",
    cwd: "/home/jerry/source/sincearc",
    updatedAt: "10 月 17 日",
    group: "更早",
    playerIds: ["pl-hermes"],
  },
];

export const messages: Message[] = [
  {
    id: "m-1",
    role: "user",
    text: "@claude 看一下 src-tauri/src/acp/launch.rs，把 WSL 那条链路补上 setsid，并在关窗时杀掉进程组。",
    at: "21:04",
  },
  { id: "m-2", role: "player", playerId: "pl-claude", text: "看完了。现在 `kill_on_drop` 只杀 `wsl.exe` 这个 relay，WSL 里的 agent 会变成孤儿。\n\n我加一个 `setsid` 包装并把 pid 记在 `AgentProcess` 上，关窗时走 `killpg`；另外 stderr 单独接了，失败时能看到 agent 自己的抱怨。", at: "21:05" },
  { id: "m-3", role: "user", text: "@hermes 你觉得这个 pid 记在哪一层合适？", at: "21:06" },
  { id: "m-4", role: "player", playerId: "pl-hermes", text: "记在 `AgentProcess` 上，别放全局表。一个玩家一个进程，进程没了 pid 也就没意义了；放全局反而要多一套清理逻辑。", at: "21:06" },
  { id: "m-5", role: "system", text: "Claude 正在修改 launch.rs", at: "21:07" },
  { id: "m-6", role: "player", playerId: "pl-claude", text: "改好了，+18 −4。顺带把 `--cd` 挪到 `zsh -lc` 之前——位置不对时 wsl 会把参数当成命令的一部分。", at: "21:08", streaming: true },
];

export const activities: Activity[] = [
  { id: "a-1", playerId: "pl-claude", kind: "thinking", title: "先确认 spawn 的形状", detail: "wsl.exe 是 relay，直接 kill 只会杀 relay…", status: "ok", at: "21:04" },
  { id: "a-2", playerId: "pl-claude", kind: "read", title: "读取 launch.rs", detail: "src-tauri/src/acp/launch.rs", meta: "96 行", status: "ok", at: "21:04" },
  { id: "a-3", playerId: "pl-claude", kind: "search", title: "搜索 kill_on_drop", meta: "3 处", status: "ok", at: "21:05" },
  { id: "a-4", playerId: "pl-claude", kind: "edit", title: "修改 launch.rs", detail: "+18 −4", status: "ok", at: "21:05" },
  { id: "a-5", playerId: "pl-claude", kind: "execute", title: "cargo check --all-targets", meta: "exit 0", status: "ok", at: "21:06" },
  { id: "a-6", playerId: "pl-hermes", kind: "thinking", title: "对比三种存放位置", status: "ok", at: "21:06" },
  { id: "a-7", playerId: "pl-claude", kind: "read", title: "读取 launch.rs", meta: "96 行", status: "ok", at: "21:08" },
  { id: "a-8", playerId: "pl-claude", kind: "edit", title: "修改 launch.rs", detail: "+18 −4", status: "running", at: "21:09" },
  { id: "a-9", playerId: "pl-hermes", kind: "read", title: "读取 transport.rs", detail: "src-tauri/src/acp/transport.rs", meta: "212 行", status: "ok", at: "21:09" },
  { id: "a-10", playerId: "pl-hermes", kind: "search", title: "搜索分帧逻辑", meta: "5 处", status: "ok", at: "21:09" },
  { id: "a-11", playerId: "pl-hermes", kind: "edit", title: "修改 transport.rs", detail: "+9 −2", status: "running", at: "21:09" },
];

export const turns: TraceTurn[] = [
  {
    id: "t-1",
    at: "21:04",
    userText: "@claude 补上 setsid，关窗时把进程组一起杀掉",
    branches: [
      {
        playerId: "pl-claude",
        activityIds: ["a-1", "a-2", "a-3", "a-4", "a-5"],
        reply: "现在 kill_on_drop 只杀 wsl.exe 这个 relay，WSL 里的 agent 会成孤儿。",
        status: "done",
      },
    ],
  },
  {
    id: "t-2",
    at: "21:06",
    userText: "@hermes pid 记在哪一层合适？",
    branches: [
      {
        playerId: "pl-hermes",
        activityIds: ["a-6"],
        reply: "记在 AgentProcess 上，别放全局表。",
        status: "done",
      },
    ],
  },
  {
    id: "t-3",
    at: "21:09",
    userText: "@claude @hermes 分头看一下：claude 查 launch.rs 的参数顺序，hermes 查 transport.rs 的分帧",
    branches: [
      {
        playerId: "pl-claude",
        activityIds: ["a-7", "a-8"],
        status: "running",
      },
      {
        playerId: "pl-hermes",
        activityIds: ["a-9", "a-10", "a-11"],
        status: "running",
      },
    ],
  },
];

export const pendingPermission: PermissionRequest = {
  id: "perm-1",
  playerId: "pl-claude",
  title: "允许修改文件？",
  detail: "想要写入 /home/jerry/source/sincearc/src-tauri/src/acp/launch.rs，改动 +18 −4 行。",
  meta: "fs/write_text_file",
  options: [
    { id: "allow", label: "允许一次", tone: "allow" },
    { id: "always", label: "本项目总是允许", tone: "always" },
    { id: "reject", label: "拒绝", tone: "reject" },
  ],
};

export const repos: GithubRepo[] = [
  {
    id: "r-1",
    name: "SinceCloud",
    slug: "wangsyiiz/SinceCloud",
    path: "/home/jerry/source/sincecloud",
    branch: "master",
    connected: true,
  },
  {
    id: "r-2",
    name: "sincecloud-web",
    slug: "wangsyiiz/sincecloud-web",
    path: "/home/jerry/source/sincecloud-web",
    branch: "main",
    connected: true,
  },
  {
    id: "r-3",
    name: "SinceArc",
    slug: "wangsyiiz/SinceArc",
    path: "C:\\source\\sincearc",
    branch: "master",
    connected: false,
  },
];

export const prsByRepo: Record<string, GithubPR[]> = {
  "r-1": [
    {
      number: 188,
      title: "KAN-134 门禁分级：任务级与回归级",
      author: "wangsyiiz",
      head: "kan134-gate-tiers",
      base: "master",
      state: "merged",
      comments: 6,
      additions: 412,
      deletions: 96,
      files: 8,
      checks: "passing",
      updatedAt: "2 小时前",
      body: "把四连门禁拆成任务级与回归级两档，并补上门禁映射表。",
    },
    {
      number: 191,
      title: "E6 站点设置：site.title / site.description 白名单键",
      author: "wangsyiiz",
      head: "kan63-site-title",
      base: "e6-admin",
      state: "draft",
      comments: 2,
      additions: 268,
      deletions: 14,
      files: 5,
      checks: "pending",
      updatedAt: "35 分钟前",
      body: "新增两个白名单键，补齐归一化与读取面。",
    },
    {
      number: 186,
      title: "fix(acp): 无边框窗口补权限",
      author: "wangsyiiz",
      head: "fix-window-perms",
      base: "master",
      state: "open",
      comments: 0,
      additions: 18,
      deletions: 6,
      files: 2,
      checks: "failing",
      updatedAt: "12 分钟前",
      body: "core:default 不含窗口变更权限，导致拖动与三键静默失效。",
    },
  ],
  "r-2": [
    {
      number: 12,
      title: "design: 石板蓝面阶与磨砂玻璃材质",
      author: "wangsyiiz",
      head: "tokens-slate",
      base: "main",
      state: "open",
      comments: 3,
      additions: 154,
      deletions: 22,
      files: 4,
      checks: "passing",
      updatedAt: "昨天",
      body: "围绕 n-0…n-6 重排面阶，玻璃只用在交互层。",
    },
    {
      number: 9,
      title: "feat: 侧栏会话分组",
      author: "wangsyiiz",
      head: "sidebar-groups",
      base: "main",
      state: "merged",
      comments: 1,
      additions: 96,
      deletions: 8,
      files: 3,
      checks: "passing",
      updatedAt: "3 天前",
      body: "按今天/昨天/更早分组，折叠状态存本地。",
    },
  ],
  "r-3": [],
};
