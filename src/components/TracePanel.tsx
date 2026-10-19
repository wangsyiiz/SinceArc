import { useEffect, useMemo, useRef } from "react";
import { FileText, PencilLine, Play, Search, Sparkles, ShieldAlert, X } from "lucide-react";
import type { Activity, ActivityKind, Player, TraceTurn } from "@/types";
import { cn } from "@/lib/utils";

const ROW = 34;
const MAIN_X = 13;
const LANE_W = 22;

const laneX = (i: number) => MAIN_X + (i + 1) * LANE_W;

type RowKind = "user" | "activity" | "reply";

interface TraceRow {
  id: string;
  x: number;
  y: number;
  kind: RowKind;
  title: string;
  meta?: string;
  at: string;
  color: string;
  status?: "ok" | "running" | "error";
  activity?: Activity;
  playerName?: string;
}

interface TraceEdge {
  d: string;
  color: string;
  dashed?: boolean;
}

function buildTrace(turns: TraceTurn[], activities: Activity[], players: Player[]) {
  const byId = new Map(activities.map((a) => [a.id, a]));
  const rows: TraceRow[] = [];
  const edges: TraceEdge[] = [];
  let y = 14;
  let lanes = 1;

  for (const t of turns) {
    const p0 = players.find((x) => x.id === t.branches[0]?.playerId);

    rows.push({
      id: `${t.id}-user`,
      x: MAIN_X,
      y,
      kind: "user",
      title: t.userText,
      at: t.at,
      color: "var(--i2)",
    });

    const branchStart = y + ROW;
    lanes = Math.max(lanes, t.branches.length);

    let maxRows = 0;
    const ends: { y: number; x: number; color: string; open: boolean }[] = [];

    t.branches.forEach((b, i) => {
      const p = players.find((x) => x.id === b.playerId) ?? p0;
      const color = p?.color ?? "var(--i3)";
      const x = laneX(i);

      edges.push({
        d: `M ${MAIN_X} ${y + 7} C ${MAIN_X} ${branchStart - 12}, ${x} ${branchStart - 12}, ${x} ${branchStart}`,
        color,
      });

      let cursor = branchStart;
      for (const id of b.activityIds) {
        const a = byId.get(id);
        if (!a) continue;
        rows.push({
          id: a.id,
          x,
          y: cursor,
          kind: "activity",
          title: a.title,
          meta: a.detail ?? a.meta,
          at: a.at,
          color,
          status: a.status,
          activity: a,
          playerName: p?.name,
        });
        cursor += ROW;
      }

      let lastY = cursor - ROW;
      if (b.reply) {
        rows.push({
          id: `${t.id}-${b.playerId}-reply`,
          x,
          y: cursor,
          kind: "reply",
          title: "回复",
          meta: b.reply,
          at: "",
          color,
          status: "ok",
          playerName: p?.name,
        });
        lastY = cursor;
        cursor += ROW;
      }

      edges.push({
        d: `M ${x} ${branchStart} L ${x} ${lastY + (b.reply ? 8 : 5)}`,
        color,
        dashed: !b.reply,
      });
      if (!b.reply) {
        edges.push({ d: `M ${x} ${lastY + 5} L ${x} ${lastY + 20}`, color, dashed: true });
      }

      ends.push({ y: lastY, x, color, open: !b.reply });
      maxRows = Math.max(maxRows, (cursor - branchStart) / ROW);
    });

    const turnEnd = branchStart + Math.max(maxRows, 1) * ROW + 2;

    // 已结束的支线弯回主干；仍在跑的支线保持开放（虚线头）
    for (const be of ends) {
      if (be.open) continue;
      edges.push({
        d: `M ${be.x} ${be.y + 8} C ${be.x} ${turnEnd - 10}, ${MAIN_X} ${turnEnd - 10}, ${MAIN_X} ${turnEnd}`,
        color: be.color,
      });
    }

    y = turnEnd + 8;
  }

  return {
    rows,
    edges,
    height: y + 6,
    width: laneX(Math.max(0, lanes - 1)) + 14,
  };
}

const KIND_ICON: Record<ActivityKind, typeof FileText> = {
  thinking: Sparkles,
  read: FileText,
  edit: PencilLine,
  execute: Play,
  search: Search,
  plan: ShieldAlert,
  permission: ShieldAlert,
};

function Mark({ row, focused, tick }: { row: TraceRow; focused: boolean; tick: number }) {
  const k = row.activity?.kind ?? "read";
  const fill = row.status === "error" ? "var(--d1)" : row.color;

  const halo = focused ? (
    <circle
      key={`halo-${tick}`}
      cx={row.x}
      cy={row.y}
      r={9.5}
      fill={fill}
      className="sc-halo-fade"
    />
  ) : null;

  const pulse =
    row.status === "running" ? (
      <circle
        cx={row.x}
        cy={row.y}
        r={7}
        fill="none"
        stroke={fill}
        strokeWidth={1.2}
        opacity={0.4}
        className="animate-pulse"
      />
    ) : null;

  if (row.kind === "user") {
    return (
      <>
        {halo}
        <circle cx={row.x} cy={row.y} r={3.6} fill="var(--i2)" />
      </>
    );
  }
  if (row.kind === "reply") {
    return (
      <>
        {halo}
        {pulse}
        <circle cx={row.x} cy={row.y} r={4.2} fill={fill} />
        <circle cx={row.x} cy={row.y} r={1.5} fill="var(--s0)" />
      </>
    );
  }
  return (
    <>
      {halo}
      {pulse}
      {k === "edit" ? (
        <rect x={row.x - 3.4} y={row.y - 3.4} width={6.8} height={6.8} rx={1.2} fill={fill} opacity={0.9} />
      ) : k === "execute" ? (
        <polygon
          points={`${row.x},${row.y - 4} ${row.x + 3.8},${row.y + 3} ${row.x - 3.8},${row.y + 3}`}
          fill={fill}
          opacity={0.9}
        />
      ) : k === "permission" ? (
        <polygon
          points={`${row.x},${row.y - 4.4} ${row.x + 4.4},${row.y} ${row.x},${row.y + 4.4} ${row.x - 4.4},${row.y}`}
          fill={fill}
        />
      ) : k === "thinking" ? (
        <circle cx={row.x} cy={row.y} r={3.2} fill="var(--s0)" stroke={fill} strokeWidth={1.5} />
      ) : k === "search" ? (
        <circle
          cx={row.x}
          cy={row.y}
          r={3}
          fill="none"
          stroke={fill}
          strokeWidth={1.4}
          strokeDasharray="2 2"
        />
      ) : (
        <circle cx={row.x} cy={row.y} r={2.2} fill={fill} />
      )}
    </>
  );
}

interface TracePanelProps {
  open: boolean;
  focusId: string | null;
  focusTick: number;
  turns: TraceTurn[];
  activities: Activity[];
  players: Player[];
  onClose: () => void;
}

export function TracePanel({
  open,
  focusId,
  focusTick,
  turns,
  activities,
  players,
  onClose,
}: TracePanelProps) {
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const { rows, edges, height, width } = useMemo(
    () => buildTrace(turns, activities, players),
    [turns, activities, players],
  );

  useEffect(() => {
    if (!open || !focusId) return;
    const el = rowRefs.current.get(focusId);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [open, focusId, focusTick]);

  const actionCount = activities.length;

  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden transition-[width] duration-200 ease-out",
        open ? "w-[338px]" : "w-0",
      )}
    >
      <div className="sc-pane flex h-full w-[338px] flex-col overflow-hidden">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
          <span className="text-[11.5px] font-medium text-ink-1">轨迹</span>
          <span className="font-mono text-[9.5px] text-ink-3">
            {turns.length} 轮 · {actionCount} 动作
          </span>
          <div className="ml-auto flex items-center gap-1">
            {players.map((p) => (
              <span
                key={p.id}
                className="size-1.5 rounded-full"
                style={{ background: p.color }}
                title={p.name}
              />
            ))}
          </div>
          <button
            onClick={onClose}
            className="ml-1 grid size-6 place-items-center rounded-[6px] text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink-1"
          >
            <X className="size-3.5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 && (
            <div className="px-4 py-10 text-center text-[11px] leading-relaxed text-ink-3">
              这个会话还没有轨迹
              <br />
              <span className="text-[10px]">@ 一个玩家开始</span>
            </div>
          )}
          <div className="flex">
            <svg width={width} height={height} className="shrink-0">
              <line
                x1={MAIN_X}
                y1={10}
                x2={MAIN_X}
                y2={height - 4}
                stroke="var(--l1)"
                strokeWidth={1}
                opacity={0.55}
              />
              {edges.map((e, i) => (
                <path
                  key={i}
                  d={e.d}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeDasharray={e.dashed ? "3 3" : undefined}
                  opacity={e.dashed ? 0.5 : 0.88}
                />
              ))}
              {rows.map((r) => (
                <Mark
                  key={`${r.id}:${r.id === focusId ? focusTick : 0}`}
                  row={r}
                  focused={r.id === focusId}
                  tick={focusTick}
                />
              ))}
            </svg>

            <div className="min-w-0 flex-1">
              {rows.map((r) => {
                const Icon = r.activity ? KIND_ICON[r.activity.kind] : null;
                return (
                  <div
                    key={`${r.id}:${r.id === focusId ? focusTick : 0}`}
                    ref={(el) => {
                      if (el) rowRefs.current.set(r.id, el);
                      else rowRefs.current.delete(r.id);
                    }}
                    style={{ height: ROW }}
                    className={cn(
                      "flex items-center gap-1.5 pr-2",
                      r.id === focusId && "sc-row-fade",
                      r.kind === "reply" ? "text-ink-1" : "text-ink-2",
                    )}
                  >
                    {r.kind === "user" ? (
                      <>
                        <span className="shrink-0 font-mono text-[9px] text-ink-3">{r.at}</span>
                        <span className="truncate text-[11px]">{r.title}</span>
                      </>
                    ) : r.kind === "reply" ? (
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="shrink-0 text-[10.5px] font-medium" style={{ color: r.color }}>
                          {r.playerName}
                        </span>
                        <span className="truncate text-[11px] text-ink-2">{r.meta ?? "回复"}</span>
                      </span>
                    ) : (
                      <>
                        {Icon && <Icon className="size-2.5 shrink-0 text-ink-3" />}
                        <span className="truncate text-[11px]">{r.title}</span>
                        {r.meta && (
                          <span className="min-w-0 truncate font-mono text-[9.5px] text-ink-3">{r.meta}</span>
                        )}
                        {r.status === "running" && (
                          <span
                            className="ml-auto size-1 shrink-0 animate-pulse rounded-full"
                            style={{ background: r.color }}
                          />
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <footer className="shrink-0 border-t border-line-1/60 px-3 py-2 text-[9.5px] leading-relaxed text-ink-3">
          主干是你的时间轴；一轮里被 @ 的玩家各开一条支线并行跑，答完弯回主干，虚线头表示还在答。
        </footer>
      </div>
    </div>
  );
}
