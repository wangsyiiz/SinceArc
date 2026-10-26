import { useState } from "react";
import type { Activity, Player } from "@/types";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "./PlayerAvatar";
import { MembersMenu } from "./MembersMenu";
import type { AgentUser } from "@/lib/ipc";
import type { AgentProfile } from "@/types";
import { useHoverCard } from "./ui/HoverCard";

interface ActivityRailProps {
  players: Player[];
  activities: Activity[];
  filter: string | null;
  onOpenMember: (member: AgentUser, anchor: HTMLElement) => void;
  /** 群成员入口（没选中会话时不传：草稿会话还没 id，拉不了人） */
  group?: {
    sessionId: string;
    members: AgentUser[];
    profiles: AgentProfile[];
    onChanged: () => void;
  };
}

export function ActivityRail({
  players,
  activities,
  filter,
  onOpenMember,
  group,
}: ActivityRailProps) {
  return (
    <aside className="flex w-11 shrink-0 flex-col items-center border-r border-line-1/50 py-3">
      {/* 成员多了要能滚，否则底部那个「+」会被顶出可视区（实测过） */}
      <div className="flex w-full min-h-0 flex-1 flex-col items-center gap-2.5 overflow-y-auto px-0.5">
      {players.map((p) => {
        const mine = activities.filter((a) => a.playerId === p.id);
        const running = mine.find((a) => a.status === "running");
        const selected = filter === p.id;
        return (
          <RailPlayerButton
            key={p.id}
            player={p}
            running={running}
            selected={selected}
            onOpen={(anchor) => {
              const member = group?.members.find((m) => m.id === p.id);
              if (member) onOpenMember(member, anchor);
            }}
          />
        );
      })}
      </div>
      {group && (
        <div className="mt-2 shrink-0">
          <MembersMenu
            sessionId={group.sessionId}
            members={group.members}
            profiles={group.profiles}
            onChanged={group.onChanged}
          />
        </div>
      )}
      <div
        className="mt-2 shrink-0 text-micro tracking-widest text-ink-3"
        style={{ writingMode: "vertical-rl" }}
      >
        {filter ?? "AGENTS"}
      </div>
    </aside>
  );
}

function RailPlayerButton({
  player,
  running,
  selected,
  onOpen,
}: {
  player: Player;
  running: Activity | undefined;
  selected: boolean;
  onOpen: (anchor: HTMLElement) => void;
}) {
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const hover = useHoverCard();
  return (
    <>
      <button
        ref={setEl}
        {...hover.triggerProps(el)}
        onClick={(event) => onOpen(event.currentTarget)}
        aria-label={`打开 ${player.name} 的详情`}
        className={cn(
          "relative grid size-7 place-items-center rounded-full transition-opacity",
          selected ? "ring-2 ring-offset-2 ring-offset-transparent" : "opacity-80 hover:opacity-100",
        )}
        /* 同上：颜色可能是 CSS 变量，只能走 color-mix，不能拼 hex 后缀 */
        style={
          selected
            ? { boxShadow: `0 0 0 2px color-mix(in srgb, ${player.color} 40%, transparent)` }
            : undefined
        }
      >
        <PlayerAvatar player={player} size={24} />
        {running && (
          <span
            className="absolute -bottom-0.5 -right-0.5 size-2 animate-pulse rounded-full border-2 border-surface-0"
            style={{ background: player.color }}
          />
        )}
      </button>
      {hover.card(
        <div>
          <div className="text-caption font-medium text-ink-1">{player.name}</div>
          {running && (
            <div className="mt-1 break-words text-caption text-ink-2">{running.title}</div>
          )}
        </div>,
      )}
    </>
  );
}
