import { Moon, Sun, MonitorSmartphone, ShieldCheck } from "lucide-react";
import type { AgentProfile, ThemeMode } from "@/types";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  cwd: string;
  profile: AgentProfile | undefined;
  theme: ThemeMode;
  onCycleTheme: () => void;
}

const THEME_ICON = {
  dark: Moon,
  light: Sun,
  system: MonitorSmartphone,
} as const;

export function StatusBar({ cwd, profile, theme, onCycleTheme }: StatusBarProps) {
  const Icon = THEME_ICON[theme];
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line-1 bg-surface-1/80 px-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2 font-mono text-[11.5px] text-ink-2">
        <span className="size-1.5 shrink-0 rounded-full bg-accent-1/80" />
        <span className="truncate">{cwd}</span>
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {profile && (
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
              profile.connected
                ? "border-ok-1/25 bg-ok-1/10 text-ok-1"
                : "border-line-1 bg-surface-2 text-ink-3",
            )}
          >
            <ShieldCheck className="size-3" />
            {profile.connected
              ? `${profile.agentName ?? "已连接"} · v${profile.protocolVersion ?? 1}`
              : "未连接"}
          </div>
        )}
        <button
          onClick={onCycleTheme}
          title={`主题：${theme}`}
          className="grid size-8 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1"
        >
          <Icon className="size-4" />
        </button>
      </div>
    </header>
  );
}
