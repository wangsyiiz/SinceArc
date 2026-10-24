import { agentBrand } from "@/lib/agent-brands";

/**
 * 连接的品牌标记：有官方 mark 就画真实形状，没有就落成字母牌（不编图标）。
 * 单色渲染 —— 形状够辨识，颜色交给应用的单色体系。
 */
export function AgentLogo({
  agent,
  size = 18,
}: {
  agent: string | null | undefined;
  size?: number;
}) {
  const brand = agentBrand(agent);
  const glyph = Math.max(10, Math.round(size * 0.66));

  if (!brand?.path) {
    const letter = (brand?.label ?? agent ?? "?").trim().charAt(0).toUpperCase() || "?";
    return (
      <span
        aria-hidden="true"
        className="inline-grid shrink-0 place-items-center rounded-mark bg-surface-3/40 text-ink-2"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.52), fontWeight: 600, lineHeight: 1 }}
      >
        {letter}
      </span>
    );
  }

  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center rounded-mark bg-surface-3/40 text-ink-1"
      style={{ width: size, height: size }}
    >
      <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="currentColor" role="presentation">
        <path d={brand.path} />
      </svg>
    </span>
  );
}
