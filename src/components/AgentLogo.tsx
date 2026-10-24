import { Brain, Code, Sparkles, Terminal } from "lucide-react";
import { agentBrand, type AgentBrand } from "@/lib/agent-brands";

const ICONS: Record<AgentBrand["icon"], typeof Terminal> = {
  sparkles: Sparkles,
  terminal: Terminal,
  brain: Brain,
  code: Code,
};

export function AgentLogo({
  agent,
  size = 18,
}: {
  agent: string | null | undefined;
  size?: number;
}) {
  const brand = agentBrand(agent);
  const iconSize = Math.max(10, Math.round(size * 0.62));

  if (!brand) {
    return (
      <span
        aria-hidden="true"
        className="inline-grid shrink-0 place-items-center rounded-mark bg-surface-3/40 text-ink-3"
        style={{ width: size, height: size }}
      >
        <Terminal size={iconSize} />
      </span>
    );
  }

  const Icon = ICONS[brand.icon];
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-mark"
      style={{
        width: size,
        height: size,
        background: `color-mix(in srgb, ${brand.color} 14%, transparent)`,
        color: brand.color,
      }}
    >
      <Icon size={iconSize} />
    </span>
  );
}
