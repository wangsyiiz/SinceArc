import type { AgentCommand, AgentProfile } from "@/types";

/**
 * ACP 之外的能力：agent 自己的 CLI 子命令。
 *
 * 边界（写死，不要绕过）：
 * - 能通过 ACP 做的不要放这里。会话列表走 `session/list`，不是 `sessions list`。
 * - agent 自带的 Web UI（如 `hermes dashboard`）不集成。
 * - 未知 agent 返回空数组：入口不出现，而不是点了报错。
 * - 只收**只读**子命令。会改状态、删数据、升级自身的（`update` / `delete` / `apply`）不放 ——
 *   这些东西点一下就生效，而现在连结果都没地方展示。
 * - **当前只做预览，不执行**：点一项只显示「将执行」那条命令。接线是后面的事。
 *
 * 每条命令的 `binary` 是跑它的二进制，**不一定等于 profile.program**：
 * codex 的 ACP 是 `npx … @agentclientprotocol/codex-acp` 起的，但它的 CLI 叫 `codex`。
 */

const HERMES: AgentCommand[] = [
  {
    id: "sessions.stats",
    binary: "hermes",
    label: "会话统计",
    argv: ["sessions", "stats"],
    note: "会话库的体积与分布",
  },
  {
    id: "sessions.prune",
    binary: "hermes",
    label: "清理旧会话",
    argv: ["sessions", "prune", "--older-than", "30d"],
    note: "会真的删数据",
  },
  {
    id: "worktree",
    binary: "hermes",
    label: "Worktree 审计",
    argv: ["worktree"],
    note: "回收已合并分支的工作树",
  },
  {
    id: "cron.list",
    binary: "hermes",
    label: "定时任务",
    argv: ["cron", "list"],
  },
];

/**
 * Codex CLI 的子命令来自 `codex --help`（2026-10-21 实机核对）：
 * agents / exec / review / login / logout / mcp / plugin / app-server / completion /
 * update / doctor / sandbox / debug / apply / resume / queue / archive / delete。
 * 只挑只读、且「在客户端里看一眼」确实有用的四条，其余不进表。
 */
const CODEX: AgentCommand[] = [
  {
    id: "doctor",
    binary: "codex",
    label: "环境诊断",
    argv: ["doctor"],
    note: "安装 / 配置 / 认证 / 运行时健康",
  },
  {
    id: "login.status",
    binary: "codex",
    label: "登录状态",
    argv: ["login", "status"],
  },
  {
    id: "mcp.list",
    binary: "codex",
    label: "MCP 服务器",
    argv: ["mcp", "list"],
  },
  {
    id: "agents",
    binary: "codex",
    label: "本地会话",
    argv: ["agents"],
    note: "共享 daemon 上的 agent 会话",
  },
];

const REGISTRY: Record<string, AgentCommand[]> = {
  hermes: HERMES,
  codex: CODEX,
};

/**
 * 从一段文本里认出是哪个 agent。
 *
 * 不能取「第一段」：agentInfo.name 各家格式完全不同，实测
 *   hermes-agent 0.22.2
 *   @agentclientprotocol/codex-acp 2.2.2   ← 第一段是 "@agentclientprotocol/codex"，永远匹配不到
 *   gemini-cli 0.65.0
 * 所以改成「文本里是否出现已知 agent 的关键词」，前后要求非字母边界，避免将来
 * 某个 agent 名字里恰好含有别人关键词的子串。
 */
function pickKey(text: string): string | null {
  const lower = text.toLowerCase();
  for (const key of Object.keys(REGISTRY)) {
    if (new RegExp(`(^|[^a-z])${key}([^a-z]|$)`).test(lower)) return key;
  }
  return null;
}

/** profile 的启动命令行，用作「还没连过、拿不到 agentInfo」时的兜底识别依据 */
export function commandLineOf(profile: { program?: string; args?: string[] } | undefined): string {
  return [profile?.program ?? "", ...(profile?.args ?? [])].filter(Boolean).join(" ");
}

/**
 * 这个 agent 有哪些 CLI 扩展。
 *
 * 优先按握手报的名字认；还没连过（没有 agentName）时退回按启动命令行认 ——
 * 否则用户刚配好 codex、还没连，面板里一条都看不到，会以为没做。
 */
export function commandsFor(
  agentName: string | null | undefined,
  commandLine?: string,
): AgentCommand[] {
  const key = (agentName ? pickKey(agentName) : null) ?? (commandLine ? pickKey(commandLine) : null);
  return key ? REGISTRY[key] : [];
}

/**
 * 面板里显示「这条命令实际会怎么跑」，不同 launch 的形态不同。
 *
 * 用命令自己的 `binary` 拼，不用 profile.program —— 后者是 ACP 的启动命令，
 * 对 codex 来说是 `npx … codex-acp`，拿它拼 `doctor` 会得到一条根本不存在的命令。
 */
export function previewCommand(profile: AgentProfile | undefined, cmd: AgentCommand): string {
  const base = [cmd.binary, ...cmd.argv].filter(Boolean).join(" ");
  if (!profile) return base;
  if (profile.launch === "ssh" && profile.ssh) {
    const { user, host, port } = profile.ssh;
    const portArg = port && port !== 22 ? ` -p ${port}` : "";
    const cwd = profile.cwd ? `cd ${profile.cwd} && ` : "";
    return `ssh -T${portArg} ${user}@${host} "${cwd}${base}"`;
  }
  if (profile.launch === "wsl") {
    return `wsl.exe -d ${profile.distro ?? "wsl"} -- ${profile.shell ?? "zsh"} -lc "${base}"`;
  }
  return base;
}
