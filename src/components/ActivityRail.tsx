import type { Activity, Player } from "@/types";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "./PlayerAvatar";

interface ActivityRailProps {
  players: Player[];
  activities: Activity[];
  filter: string | null;
  onFilter: (playerId: string | null) => void;
}

export function ActivityRail({ players, activities, filter, onFilter }: ActivityRailProps) {
  return (
    <aside className="flex w-11 shrink-0 flex-col items-center gap-2.5 border-r border-line-1/50 py-3">
      {players.map((p) => {
        const mine = activities.filter((a) => a.playerId === p.id);
        const running = mine.find((a) => a.status === "running");
        const selected = filter === p.id;
        return (
          <button
            key={p.id}
            onClick={() => onFilter(selected ? null : p.id)}
            title={running ? `${p.name}：${running.title}` : p.name}
            className={cn(
              "relative grid size-7 place-items-center rounded-full transition-all",
              selected ? "ring-2 ring-offset-2 ring-offset-transparent" : "opacity-80 hover:opacity-100",
            )}
            style={selected ? { boxShadow: `0 0 0 2px ${p.color}66` } : undefined}
          >
            <PlayerAvatar player={p} size={24} />
            {running && (
              <span
                className="absolute -bottom-0.5 -right-0.5 size-2 animate-pulse rounded-full border-2"
                style={{ background: p.color, borderColor: "var(--s0)" }}
              />
            )}
          </button>
        );
      })}
      <div className="mt-auto text-[9px] tracking-widest text-ink-3 [writing-mode:vertical-rl]">
        {filter ?? "AGENTS"}
      </div>
    </aside>
  );
}
