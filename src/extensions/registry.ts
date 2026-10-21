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

/** agentInfo.name 形如 "hermes-agent 0.22.2" / "codex-acp 2.2.2"，取第一段做 key */
export function commandsFor(agentName: string | null | undefined): AgentCommand[] {
  if (!agentName) return [];
  const key = agentName.trim().split(/[\s\-_]/)[0].toLowerCase();
  return REGISTRY[key] ?? [];
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
