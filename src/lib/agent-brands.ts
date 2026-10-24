/**
 * Agent 品牌标记 —— **这是数据，不属于设计令牌体系**（与 `player-colors.ts` 同类）。
 *
 * 色值只活在这个模块里，由 `style-guard` 的 color-literal 规则按文件豁免；
 * 组件只能通过 `agentBrand()` 拿到颜色，再用 `color-mix` 稀释成背景。
 * 不认识的 agent 一律返回 null，由 `AgentLogo` 走中性样式，不猜品牌。
 */
export interface AgentBrand {
  label: string;
  color: string;
  icon: "sparkles" | "terminal" | "brain" | "code";
}

const BRANDS: (AgentBrand & { keys: string[] })[] = [
  { keys: ["hermes"], label: "Hermes", color: "#c084fc", icon: "sparkles" },
  { keys: ["claude", "anthropic"], label: "Claude", color: "#d97757", icon: "brain" },
  { keys: ["codex", "openai"], label: "Codex", color: "#7dd3a8", icon: "terminal" },
  { keys: ["gemini"], label: "Gemini", color: "#8ab4f8", icon: "sparkles" },
  { keys: ["qwen"], label: "Qwen", color: "#7c8cff", icon: "terminal" },
  { keys: ["goose"], label: "Goose", color: "#f6ad55", icon: "terminal" },
  { keys: ["opencode"], label: "OpenCode", color: "#94a3b8", icon: "terminal" },
];

/** 按 agent 名（agentInfo.name 或 profile.program）里的关键字匹配；不认识的走中性。 */
export function agentBrand(nameOrProgram: string | null | undefined): AgentBrand | null {
  const value = nameOrProgram?.trim().toLowerCase();
  if (!value) return null;
  const brand = BRANDS.find(({ keys }) => keys.some((key) => value.includes(key)));
  return brand ? { label: brand.label, color: brand.color, icon: brand.icon } : null;
}
