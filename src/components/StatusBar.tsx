import { ChevronDown, Moon, Sun, MonitorSmartphone, ShieldCheck } from "lucide-react";
import type { AgentProfile, ThemeMode } from "@/types";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  cwd: string;
  profile: AgentProfile | undefined;
  theme: ThemeMode;
  onCycleTheme: () => void;
}

const THEME_ICON = { dark: Moon, light: Sun, system: MonitorSmartphone } as const;

export function StatusBar({ cwd, profile, theme, onCycleTheme }: StatusBarProps) {
  const Icon = THEME_ICON[theme];

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line-1/80 px-3.5">
      <button className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:bg-white/[0.04] hover:text-ink-1">
        <span className="truncate">{cwd}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-3" />
      </button>

      <div className="ml-auto flex items-center gap-1">
        {profile && (
          <div
            className={cn(
              "mr-1 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px]",
              profile.connected
                ? "border-ok-1/20 bg-ok-1/[0.08] text-ok-1"
                : "border-line-1 bg-surface-2 text-ink-3",
            )}
          >
            <ShieldCheck className="size-2.5" />
            {profile.connected
              ? `${profile.agentName ?? "已连接"} · v${profile.protocolVersion ?? 1}`
              : "未连接"}
          </div>
        )}
        <button
          onClick={onCycleTheme}
          title={`主题：${theme}`}
          className="grid size-7 place-items-center rounded-md text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink-1"
        >
          <Icon className="size-3.5" />
        </button>
      </div>
    </header>
  );
}
