import { useMemo } from "react";
import {
  Braces,
  ChevronDown,
  ChevronUp,
  FileText,
  PencilLine,
  Play,
  Search,
  Sparkles,
  ShieldAlert,
} from "lucide-react";
import type { Activity, ActivityKind, Player } from "@/types";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "./PlayerAvatar";

const ICONS: Record<ActivityKind, typeof FileText> = {
  thinking: Sparkles,
  read: FileText,
  edit: PencilLine,
  execute: Play,
  search: Search,
  plan: Braces,
  permission: ShieldAlert,
};

interface ActivityPanelProps {
  activities: Activity[];
  players: Player[];
  filter: string | null;
  open: boolean;
  onToggle: () => void;
}

export function ActivityPanel({ activities, players, filter, open, onToggle }: ActivityPanelProps) {
  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const visible = useMemo(
    () => (filter ? activities.filter((a) => a.playerId === filter) : activities),
    [activities, filter],
  );
  const running = activities.filter((a) => a.status === "running");

  return (
    <section
      className={cn(
        "shrink-0 border-t border-line-1/60 transition-[height] duration-200",
        open ? "h-[196px]" : "h-8",
      )}
    >
      <button
        onClick={onToggle}
        className="flex h-8 w-full items-center gap-2 px-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span className="text-[10.5px] font-medium tracking-wide text-ink-3">活动</span>
        <span className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          {running.length === 0 ? (
            <span className="text-[11px] text-ink-3">所有玩家空闲</span>
          ) : (
            running.map((a) => {
              const p = byId.get(a.playerId);
              if (!p) return null;
              return (
                <span key={a.id} className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-2">
                  <PlayerAvatar player={p} size={14} />
                  <span className="tabular-nums" style={{ color: p.color }}>
                    {p.name}
                  </span>
                  <span className="truncate">{a.title}</span>
                </span>
              );
            })
          )}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink-3">{activities.length}</span>
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        ) : (
          <ChevronUp className="size-3.5 shrink-0 text-ink-3" />
        )}
      </button>

      {open && (
        <div className="h-[164px] overflow-y-auto px-2 pb-2">
          {visible.length === 0 && (
            <div className="py-6 text-center text-[11px] text-ink-3">没有活动</div>
          )}
          {visible.map((a) => {
            const p = byId.get(a.playerId);
            const Icon = ICONS[a.kind];
            return (
              <div
                key={a.id}
                className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[11.5px] hover:bg-white/[0.03]"
              >
                <span className="w-3 font-mono text-[9.5px] text-ink-3">{a.at}</span>
                {p && <PlayerAvatar player={p} size={14} />}
                <Icon className="size-3 shrink-0 text-ink-3" />
                <span className="shrink-0 text-ink-2">{a.title}</span>
                {a.detail && (
                  <span className="min-w-0 truncate font-mono text-[10.5px] text-ink-3">
                    {a.detail}
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {a.meta && <span className="font-mono text-[10px] text-ink-3">{a.meta}</span>}
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      a.status === "ok" && "bg-ok-1/70",
                      a.status === "running" && "animate-pulse bg-accent-1",
                      a.status === "error" && "bg-danger-1",
                    )}
                  />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
