import type { AgentCommand, AgentProfile } from "@/types";

/**
 * ACP 之外的能力：agent 自己的 CLI 子命令。
 *
 * 边界（写死，不要绕过）：
 * - 能通过 ACP 做的不要放这里。会话列表走 `session/list`，不是 `sessions list`。
 * - agent 自带的 Web UI（如 `hermes dashboard`）不集成。
 * - 未知 agent 返回空数组：入口不出现，而不是点了报错。
 */
const HERMES: AgentCommand[] = [
  {
    id: "sessions.stats",
    label: "会话统计",
    argv: ["sessions", "stats"],
    note: "会话库的体积与分布",
  },
  {
    id: "sessions.prune",
    label: "清理旧会话",
    argv: ["sessions", "prune", "--older-than", "30d"],
    note: "会真的删数据",
  },
  {
    id: "worktree",
    label: "Worktree 审计",
    argv: ["worktree"],
    note: "回收已合并分支的工作树",
  },
  {
    id: "cron.list",
    label: "定时任务",
    argv: ["cron", "list"],
  },
];

const REGISTRY: Record<string, AgentCommand[]> = {
  hermes: HERMES,
};

/** agentInfo.name 形如 "hermes-agent 0.22.2"，取第一段做 key */
export function commandsFor(agentName: string | null | undefined): AgentCommand[] {
  if (!agentName) return [];
  const key = agentName.trim().split(/[\s\-_]/)[0].toLowerCase();
  return REGISTRY[key] ?? [];
}

/** 面板里显示「这条命令实际会怎么跑」，不同 launch 的形态不同 */
export function previewCommand(profile: AgentProfile | undefined, argv: string[]): string {
  if (!profile) return argv.join(" ");
  // 以前这里写死成 hermes：换成别的 agent 之后预览会骗人
  const base = [profile.program ?? "", ...(profile.args ?? []), ...argv].filter(Boolean).join(" ");
  if (profile.launch === "ssh" && profile.ssh) {
    const { user, host, port } = profile.ssh;
    const portArg = port && port !== 22 ? ` -p ${port}` : "";
    const cwd = profile.cwd ? `cd ${profile.cwd} && ` : "";
    return `ssh -T${portArg} ${user}@${host} "${cwd}${base}"`;
  }
  if (profile.launch === "wsl") {
    return `wsl.exe -- ${profile.shell ?? "zsh"} -lc "${base}"`;
  }
  return base;
}
