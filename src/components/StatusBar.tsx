import { ChevronDown, GitPullRequest, Moon, Sun, MonitorSmartphone, ShieldCheck, Waypoints } from "lucide-react";
import type { AgentProfile, ThemeMode } from "@/types";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  cwd: string;
  profile: AgentProfile | undefined;
  theme: ThemeMode;
  onCycleTheme: () => void;
  onOpenGithub: () => void;
  traceOpen: boolean;
  onToggleTrace: () => void;
}

const THEME_ICON = { dark: Moon, light: Sun, system: MonitorSmartphone } as const;

export function StatusBar({ cwd, profile, theme, onCycleTheme, onOpenGithub, traceOpen, onToggleTrace }: StatusBarProps) {
  const Icon = THEME_ICON[theme];

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
      <button
        onClick={onToggleTrace}
        title={traceOpen ? "收起轨迹" : "展开轨迹"}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-[6px] transition-colors",
          traceOpen ? "bg-white/[0.07] text-ink-1" : "text-ink-2 hover:bg-white/[0.06] hover:text-ink-1",
        )}
      >
        <Waypoints className="size-3.5" />
      </button>

      <button className="flex min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:bg-white/[0.04] hover:text-ink-1">
        <span className="truncate">{cwd}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-3" />
      </button>

      <div className="ml-auto flex items-center gap-0.5">
        {profile && (
          <div
            className={cn(
              "mr-1 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]",
              profile.connected
                ? "border-ok-1/20 bg-ok-1/[0.08] text-ok-1"
                : "border-line-1 bg-white/[0.03] text-ink-3",
            )}
          >
            <ShieldCheck className="size-2.5" />
            {profile.connected ? `${profile.agentName ?? "已连接"} · v${profile.protocolVersion ?? 1}` : "未连接"}
          </div>
        )}
        <button
          onClick={onOpenGithub}
          title="GitHub"
          className="grid size-7 place-items-center rounded-[6px] text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink-1"
        >
          <GitPullRequest className="size-3.5" />
        </button>
        <button
          onClick={onCycleTheme}
          title={`主题：${theme}`}
          className="grid size-7 place-items-center rounded-[6px] text-ink-2 transition-colors hover:bg-white/[0.06] hover:text-ink-1"
        >
          <Icon className="size-3.5" />
        </button>
      </div>
    </header>
  );
}
