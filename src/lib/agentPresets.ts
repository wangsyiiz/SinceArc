/**
 * 内置 agent 预设。
 *
 * 数据来自 ACP 官方注册表（https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json，
 * 2026-10-21 快照，43 条）。注册表里 distribution 只有三种形态，命令可以直接推出来：
 *
 *   npx   { package, args? }                 → npx -y <package> <args...>
 *   uvx   { package, args? }                 → uvx <package> <args...>
 *   binary{ "<platform>": { cmd, args } }    → 需要用户机器上已经装好，命令行是 <cmd> <args...>
 *
 * 这里只收「一条命令就能起、且我确认过形态」的几个；剩下的用「自定义命令」填，
 * 不在代码里硬编码一堆我没跑过的命令 —— 那条路留给用户和「探测」按钮去证明。
 */
export interface AgentPreset {
  id: string;
  name: string;
  program: string;
  args: string[];
  /** 命令的出处，界面上给用户看，方便自己核对 */
  origin: string;
  /** 前置条件；缺了就会在探测时报错 */
  requires?: string;
}

const REGISTRY_ORIGIN = "ACP Registry 2026-10-21";

export const AGENT_PRESETS: AgentPreset[] = [
  {
    id: "hermes",
    name: "Hermes Agent",
    program: "hermes",
    args: ["acp"],
    origin: "本机 hermes（实测 0.22.2 支持 ACP）",
  },
  {
    id: "claude-acp",
    name: "Claude Agent",
    program: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.94.0"],
    origin: REGISTRY_ORIGIN,
    requires: "node / npx",
  },
  {
    id: "codex-acp",
    name: "Codex",
    program: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@2.2.2"],
    origin: REGISTRY_ORIGIN,
    requires: "node / npx",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    program: "npx",
    args: ["-y", "@google/gemini-cli@0.65.0", "--acp"],
    origin: REGISTRY_ORIGIN,
    requires: "node / npx",
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    program: "npx",
    args: ["-y", "@qwen-code/qwen-code@0.25.3", "--acp", "--experimental-skills"],
    origin: REGISTRY_ORIGIN,
    requires: "node / npx",
  },
  {
    id: "opencode",
    name: "OpenCode",
    program: "opencode",
    args: ["acp"],
    origin: `${REGISTRY_ORIGIN}（binary 分发，需先自己安装）`,
    requires: "已安装 opencode",
  },
  {
    id: "goose",
    name: "Goose",
    program: "goose",
    args: ["acp"],
    origin: `${REGISTRY_ORIGIN}（binary 分发，需先自己安装）`,
    requires: "已安装 goose",
  },
];

/** 当前 program/args 命中哪个预设；一个都不匹配就是自定义 */
export function matchPreset(program: string | undefined, args: string[] | undefined): AgentPreset | null {
  const p = (program ?? "").trim();
  const a = args ?? [];
  return (
    AGENT_PRESETS.find((preset) => preset.program === p && preset.args.join(" ") === a.join(" ")) ?? null
  );
}

/** 把界面上的一行命令拆成 program + args（用户粘贴「npx -y foo --acp」时用） */
export function splitCommand(line: string): { program: string; args: string[] } {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  return { program: parts[0] ?? "", args: parts.slice(1) };
}

export function joinCommand(program: string | undefined, args: string[] | undefined): string {
  return [program ?? "", ...(args ?? [])].filter(Boolean).join(" ");
}
