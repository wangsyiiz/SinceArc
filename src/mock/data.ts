import type {
  AgentProfile,
  Message,
  PermissionRequest,
  SessionSummary,
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
];

export const sessions: SessionSummary[] = [
  {
    id: "s-1",
    title: "给 SinceArc 加会话侧栏",
    cwd: "/home/jerry/source/sincearc",
    updatedAt: "刚刚",
    group: "今天",
  },
  {
    id: "s-2",
    title: "ACP 流式渲染的合批策略",
    cwd: "/home/jerry/source/sincearc",
    updatedAt: "12 分钟前",
    group: "今天",
  },
  {
    id: "s-3",
    title: "fs/read_text_file 的沙箱校验",
    cwd: "/home/jerry/source/sincearc/src-tauri",
    updatedAt: "昨天",
    group: "昨天",
  },
  {
    id: "s-4",
    title: "Tauri 打包体积对比",
    cwd: "/home/jerry/source/sincearc",
    updatedAt: "10 月 17 日",
    group: "更早",
  },
];

export const messages: Message[] = [
  {
    id: "m-1",
    role: "user",
    kind: "text",
    text: "看一下 src-tauri/src/acp/launch.rs，把 WSL 那条链路补上 setsid，并在关窗时杀掉进程组。",
    at: "21:04",
  },
  {
    id: "m-2",
    role: "agent",
    kind: "thinking",
    text: "先确认现在 spawn 的形状：wsl.exe 作为 relay 会吞掉信号，直接 kill 只会杀掉 relay，WSL 里的 agent 会变成孤儿。需要拿到真实 pid。",
    at: "21:04",
  },
  {
    id: "m-3",
    role: "agent",
    kind: "tool_call",
    at: "21:05",
    call: {
      id: "tc-1",
      title: "读取 launch.rs",
      kind: "read",
      status: "ok",
      meta: "96 行",
      detail:
        "src-tauri/src/acp/launch.rs\n\npub fn spawn(profile: &AgentProfile, cwd: &Path) -> Result<Child> {\n    let mut cmd = match profile.launch {\n        Launch::Local => Command::new(&profile.program),\n        Launch::Wsl { distro, shell } => { ... }\n    };\n}",
    },
  },
  {
    id: "m-4",
    role: "agent",
    kind: "tool_call",
    at: "21:05",
    call: {
      id: "tc-2",
      title: "运行 cargo check",
      kind: "execute",
      status: "running",
      meta: "进行中",
      detail: "cargo check -p sincearc --all-targets",
    },
  },
  {
    id: "m-5",
    role: "agent",
    kind: "tool_call",
    at: "21:06",
    call: {
      id: "tc-3",
      title: "修改 launch.rs",
      kind: "edit",
      status: "pending",
      meta: "+18 −4",
      detail:
        "--- a/src-tauri/src/acp/launch.rs\n+++ b/src-tauri/src/acp/launch.rs\n@@ -41,6 +41,10 @@\n-    let child = cmd.spawn()?;\n+    let child = cmd\n+        .arg(profile.program.as_str())\n+        .spawn()?;\n+    // 记录 pid，关窗时 killpg",
    },
  },
  {
    id: "m-6",
    role: "user",
    kind: "text",
    text: "顺便把 stderr 单独接到 debug 面板，别跟 stdout 混。",
    at: "21:07",
  },
  {
    id: "m-7",
    role: "agent",
    kind: "text",
    streaming: true,
    at: "21:07",
    text: "明白。stdout 只留给 JSON-RPC，stderr 我另外开一条 tokio::io::BufReader，按行推到 acp://stderr 事件里，界面上做成一个可折叠的日志抽屉。这样 agent 起不来的时候能直接看到它最后几行抱怨，而不是对着一个转圈的界面猜。",
  },
];

export const pendingPermission: PermissionRequest = {
  id: "perm-1",
  title: "允许修改文件？",
  detail:
    "agent 想要写入 /home/jerry/source/sincearc/src-tauri/src/acp/launch.rs，改动 +18 −4 行。",
  meta: "tool_call_update · edit",
  options: [
    { id: "allow", label: "允许一次", tone: "allow" },
    { id: "always", label: "本项目总是允许", tone: "always" },
    { id: "reject", label: "拒绝", tone: "reject" },
  ],
};
