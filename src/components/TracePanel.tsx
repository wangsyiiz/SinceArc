import { useEffect, useMemo, useRef, useState } from "react";
import { AlignLeft, FileText, PencilLine, Play, Search, SendHorizontal, Sparkles, ShieldAlert, ShieldCheck, ShieldX, Waypoints, X } from "lucide-react";
import type { Activity, ActivityKind, Player, TraceTurn } from "@/types";
import { cn } from "@/lib/utils";
import { isTurnCancelled } from "@/lib/turn-status";
import type { LocateTarget } from "@/lib/turn-anchors";
import { Button } from "./ui/Button";
import { useHoverCard } from "./ui/HoverCard";
import { RemovedBadge } from "./RemovedBadge";

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
  status?: "ok" | "running" | "waiting" | "error" | "cancelled";
  /** 轮次抬头专用：结局文字与悬停原因（活动行不用） */
  statusLabel?: string;
  statusTitle?: string;
  activity?: Activity;
  playerName?: string;
  /** 轮抬头专用：该行代表哪一轮，供轨迹 → 正文 / 正文 → 轨迹定位 */
  turnId?: string;
  removed?: boolean;
  deleted?: boolean;
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
    const outcome = turnOutcome(t);

    rows.push({
      id: `${t.id}-user`,
      x: MAIN_X,
      y,
      kind: "user",
      title: t.userText,
      at: t.at,
      color: "var(--i2)",
      status: outcome.dot,
      statusLabel: outcome.label,
      statusTitle: outcome.title,
      turnId: t.id,
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
          removed: p?.removed,
          deleted: p?.deleted,
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
          removed: p?.removed,
          deleted: p?.deleted,
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
  delegate: SendHorizontal,
};

function activityIcon(activity?: Activity): typeof FileText {
  if (activity?.kind === "permission" && activity.decision === "allow") return ShieldCheck;
  if (activity?.kind === "permission" && activity.decision === "reject") return ShieldX;
  return activity ? KIND_ICON[activity.kind] : Waypoints;
}

function statusDotClass(status: TraceRow["status"]): string | undefined {
  if (status === "ok") return "bg-ok-1/70";
  if (status === "running") return "animate-pulse bg-accent-1";
  if (status === "waiting") return "bg-warn-1";
  if (status === "error") return "bg-danger-1";
  if (status === "cancelled") return "bg-ink-3";
  return undefined;
}

function turnOutcome(turn: TraceTurn): {
  label: string;
  dot?: TraceRow["status"];
  title?: string;
} {
  switch (turn.status) {
    case "running":
      return { label: "进行中", dot: "running" };
    case "waiting_approval":
      return { label: "等你批准", dot: "waiting" };
    case "failed":
      return { label: "失败", dot: "error", title: turn.stopReason };
    case "finished":
      if (isTurnCancelled(turn.status, turn.stopReason)) {
        return { label: "已停止", dot: "cancelled" };
      }
      return turn.stopReason && turn.stopReason !== "end_turn"
        ? { label: `已结束（${turn.stopReason}）`, dot: "ok", title: turn.stopReason }
        : { label: "已结束", dot: "ok" };
    default:
      return { label: "结局未知" };
  }
}

function turnStatusTextClass(status: TraceRow["status"]): string {
  if (status === "waiting") return "text-warn-1";
  if (status === "error") return "text-danger-1";
  return "text-ink-3";
}

function HoverContent({ row }: { row: TraceRow }) {
  const activity = row.activity;
  const Icon = activityIcon(activity);

  /* 抬头是「这是什么」，正文是「内容」—— 两者别混。
     思考条目的 title 在列表里被切成 42 字（列表宽度决定），如果照搬到卡片抬头，
     看起来就像卡片里的内容也被截了；所以抬头只写「思考」，全文进正文（后端保留 8KB，含换行）。 */
  const headline =
    row.kind === "user"
      ? "提问"
      : row.kind === "reply"
        ? `${row.playerName ?? "玩家"} 回复`
        : activity?.kind === "thinking"
          ? "思考"
          : (activity?.title ?? row.title);
  const body =
    row.kind === "user"
      ? row.title
      : row.kind === "reply"
        ? (row.meta || "回复正文在聊天区")
        : (activity?.body ?? activity?.detail ?? row.meta);

  return (
    <div>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3 shrink-0 text-ink-3" />
        <div className="min-w-0 flex-1">
          <div className="break-words text-caption font-medium text-ink-1">{headline}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-3">
            {row.at && <span className="font-mono">{row.at}</span>}
            {row.playerName && <span style={{ color: row.color }}>{row.playerName}</span>}
            <RemovedBadge player={row} />
            {row.status && (
              <span
                aria-hidden="true"
                className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(row.status))}
              />
            )}
          </div>
        </div>
      </div>
      {body && (
        <div className="mt-2 whitespace-pre-wrap break-words text-caption text-ink-2">{body}</div>
      )}
      {row.statusTitle && (
        <div className="mt-2 break-words text-micro text-ink-3">{row.statusTitle}</div>
      )}
      {activity?.truncated && (
        <div className="mt-2 text-micro text-ink-3">
          {/* 两种上限不一样：思考正文 8KB，工具调用的 rawInput / content 各 16KB（docs/acp-notes.md） */}
          {activity.kind === "thinking" ? "已截断，仅保留最早 8KB" : "已截断，仅保留前 16KB"}
        </div>
      )}
    </div>
  );
}

function TurnLocateControl({
  target,
  onLocate,
}: {
  target: LocateTarget;
  onLocate: (messageId: string) => void;
}) {
  const reason =
    target.kind === "legacy"
      ? "这一轮没有记录正文归属（M1 之前的数据）"
      : target.kind === "empty"
        ? "这一轮没有正文"
        : null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {reason && <span className="min-w-0 truncate text-micro text-ink-3">{reason}</span>}
      <Button
        variant="ghost"
        size="sm"
        disabled={target.kind !== "ok"}
        aria-label="定位到正文"
        onClick={() => {
          if (target.kind === "ok") onLocate(target.messageId);
        }}
        className="h-auto shrink-0 gap-1 rounded-mark px-1.5 py-1 text-caption"
      >
        <AlignLeft className="size-3" />
        定位到正文
      </Button>
    </span>
  );
}

function ActivityListRow({ activity, player }: { activity: Activity; player?: Player }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const hover = useHoverCard();
  const Icon = activityIcon(activity);
  const row: TraceRow = {
    id: activity.id,
    x: 0,
    y: 0,
    kind: "activity",
    title: activity.title,
    meta: activity.detail ?? activity.meta,
    at: activity.at,
    color: player?.color ?? "var(--i3)",
    status: activity.status,
    activity,
    playerName: player?.name,
    removed: player?.removed,
    deleted: player?.deleted,
  };

  return (
    <>
      <div
        ref={setEl}
        {...hover.triggerProps(el)}
        className="transition-colors duration-150 flex items-center gap-1.5 rounded-mark px-1 py-1 text-caption hover:bg-surface-2/50"
      >
        <span className="w-7 shrink-0 font-mono text-micro text-ink-3">{activity.at}</span>
        {player && (
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: player.color }}
            title={player.name}
          />
        )}
        <Icon className="size-2.5 shrink-0 text-ink-3" />
        <span className="shrink-0 text-ink-2">{activity.title}</span>
        {activity.detail && (
          <span className="min-w-0 truncate font-mono text-micro text-ink-3">
            {activity.detail}
          </span>
        )}
        <span
          className={cn(
            "ml-auto size-1 shrink-0 rounded-full",
            statusDotClass(activity.status),
          )}
        />
      </div>
      {hover.card(<HoverContent row={row} />)}
    </>
  );
}

function Mark({ row, focused, tick }: { row: TraceRow; focused: boolean; tick: number }) {
  const [el, setEl] = useState<SVGGElement | null>(null);
  const hover = useHoverCard();
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

  const glyph =
    row.kind === "user" ? (
      <>
        {halo}
        <circle cx={row.x} cy={row.y} r={3.6} fill="var(--i2)" />
      </>
    ) : row.kind === "reply" ? (
      <>
        {halo}
        {pulse}
        <circle cx={row.x} cy={row.y} r={4.2} fill={fill} />
        <circle cx={row.x} cy={row.y} r={1.5} fill="var(--s0)" />
      </>
    ) : (
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

  return (
    <>
      <g ref={setEl} {...hover.triggerProps(el)}>
        {/* 命中区：圆点本身只有 7~8px，指针几乎点不中。透明 circle 只接事件、不参与绘制。
            r=9 是逐档试出来的上限：行距 34、泳道 22，再大就会和邻行/邻道抢指针。 */}
        <circle cx={row.x} cy={row.y} r={9} fill="transparent" />
        {glyph}
      </g>
      {hover.card(<HoverContent row={row} />)}
    </>
  );
}

/**
 * 图视图右侧的文字列。**人眼的落点在这里**（不是 SVG 里 7~8px 的圆点），
 * 所以 hover 卡片绑在这一行上；行 hover 面与列表视图的行一致（§3.6），
 * 否则同一块面板里两种视图的悬停反馈不一样。
 */
function GraphLabelRow({
  row: r,
  focusId,
  register,
  registerTurn,
  locateOf,
  onLocate,
}: {
  row: TraceRow;
  focusId: string | null;
  register: (id: string, el: HTMLDivElement | null) => void;
  registerTurn: (id: string, el: HTMLDivElement | null) => void;
  locateOf: (turnId: string) => LocateTarget;
  onLocate: (messageId: string) => void;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const hover = useHoverCard();
  const Icon = r.activity ? KIND_ICON[r.activity.kind] : null;

  return (
    <>
      <div
        ref={(node) => {
          setEl(node);
          register(r.id, node);
          if (r.kind === "user" && r.turnId) registerTurn(r.turnId, node);
        }}
        {...hover.triggerProps(el)}
        data-turn-id={r.kind === "user" ? r.turnId : undefined}
        style={{ height: ROW }}
        title={r.statusTitle}
        className={cn(
          "flex items-center gap-1.5 rounded-mark pr-2 transition-colors hover:bg-surface-2/50",
          r.id === focusId && "sc-row-fade",
          r.kind === "reply" ? "text-ink-1" : "text-ink-2",
        )}
      >
        {r.kind === "user" ? (
          <>
            <span className="shrink-0 font-mono text-micro text-ink-3">{r.at}</span>
            <span className="min-w-0 truncate text-caption">{r.title}</span>
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              <TurnLocateControl target={locateOf(r.turnId ?? "")} onLocate={onLocate} />
              {r.statusLabel && (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 text-micro",
                    turnStatusTextClass(r.status),
                  )}
                  title={r.statusTitle}
                >
                  {r.status && (
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(r.status))}
                    />
                  )}
                  <span className="truncate">{r.statusLabel}</span>
                </span>
              )}
            </span>
          </>
        ) : r.kind === "reply" ? (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-caption font-medium" style={{ color: r.color }}>
              {r.playerName}
            </span>
            <RemovedBadge player={r} />
            <span className="truncate text-caption text-ink-2">{r.meta ?? "回复"}</span>
          </span>
        ) : (
          <>
            {Icon && <Icon className="size-2.5 shrink-0 text-ink-3" />}
            <span className="truncate text-caption">{r.title}</span>
            {r.meta && (
              <span className="min-w-0 truncate font-mono text-micro text-ink-3">{r.meta}</span>
            )}
            <RemovedBadge player={r} />
            {r.status === "running" && (
              <span
                className="ml-auto size-1 shrink-0 animate-pulse rounded-full"
                style={{ background: r.color }}
              />
            )}
          </>
        )}
      </div>
      {hover.card(<HoverContent row={r} />)}
    </>
  );
}

interface TracePanelProps {
  open: boolean;
  focusId: string | null;
  focusTick: number;
  locateTurnId: string | null;
  locateTick: number;
  locateTargetOf: (turnId: string) => LocateTarget;
  onLocateMessage: (messageId: string) => void;
  turns: TraceTurn[];
  activities: Activity[];
  players: Player[];
  resumeGap: number | null;
  onClose: () => void;
  width: number;
  animate: boolean;
}

export function TracePanel({
  open,
  focusId,
  focusTick,
  locateTurnId,
  locateTick,
  locateTargetOf,
  onLocateMessage,
  turns,
  activities,
  players,
  resumeGap,
  onClose,
  width,
  animate,
}: TracePanelProps) {
  const [view, setView] = useState<"graph" | "list">("graph");
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const turnRefs = useRef(new Map<string, HTMLDivElement>());
  const { rows, edges, height, width: svgWidth } = useMemo(
    () => buildTrace(turns, activities, players),
    [turns, activities, players],
  );

  useEffect(() => {
    if (!open || !focusId) return;
    const el = rowRefs.current.get(focusId);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [open, focusId, focusTick]);

  useEffect(() => {
    if (!open || !locateTurnId) return;
    const el = turnRefs.current.get(locateTurnId);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [open, locateTurnId, locateTick, turns, view]);

  const registerTurn = (id: string, el: HTMLDivElement | null) => {
    if (el) turnRefs.current.set(id, el);
    else turnRefs.current.delete(id);
  };

  const actionCount = activities.length;
  const listGroups = useMemo(() => {
    return turns.map((turn) => {
      const ids = new Set(turn.branches.flatMap((branch) => branch.activityIds));
      return {
        turn,
        activities: activities.filter((activity) => ids.has(activity.id)),
      };
    });
  }, [turns, activities]);

  return (
    <div
      className={cn(
        "shrink-0 overflow-hidden",
        animate && "transition-[width] duration-200 ease-out",
      )}
      style={{ width: open ? width : 0 }}
    >
      <div style={{ width }} className="sc-pane flex h-full flex-col overflow-hidden">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
          <span className="text-ui-tight font-medium text-ink-1">轨迹</span>
          <span className="font-mono text-micro text-ink-3">
            {turns.length} 轮 · {actionCount} 动作
          </span>
          <div className="ml-auto flex items-center gap-0.5 rounded-mark bg-surface-3/35 p-0.5">
            <button
              onClick={() => setView("graph")}
              title="图形"
              className={cn(
                "grid size-5 place-items-center rounded-mark transition-colors",
                view === "graph" ? "bg-surface-3/85 text-ink-1" : "text-ink-3 hover:text-ink-2",
              )}
            >
              <Waypoints className="size-3" />
            </button>
            <button
              onClick={() => setView("list")}
              title="列表"
              className={cn(
                "grid size-5 place-items-center rounded-mark transition-colors",
                view === "list" ? "bg-surface-3/85 text-ink-1" : "text-ink-3 hover:text-ink-2",
              )}
            >
              <AlignLeft className="size-3" />
            </button>
          </div>
          <button
            onClick={onClose}
            className="ml-1 grid size-6 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-1"
          >
            <X className="size-3.5" />
          </button>
        </header>

        {/* design-language §11：主动截断/清理的数据必须在界面上讲清楚，否则看起来像 bug */}
        <div className="shrink-0 border-b border-line-1/40 px-3 py-1 text-micro leading-relaxed text-ink-3">
          思考过程只保留开头 8KB；轨迹保留 90 天（最多 5 万条），超出会自动清理。
        </div>

        {view === "list" && (
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
            {turns.length === 0 && (
              <div className="py-8 text-center text-caption text-ink-3">没有活动</div>
            )}
            {listGroups.map(({ turn, activities: rows }) => {
              const outcome = turnOutcome(turn);
              return (
                <div
                  key={turn.id}
                  ref={(el) => registerTurn(turn.id, el)}
                  data-turn-id={turn.id}
                  className="mb-1"
                >
                  <div className="flex items-center gap-1.5 px-1 py-1" title={outcome.title}>
                    <span className="shrink-0 font-mono text-micro text-ink-3">{turn.at}</span>
                    <span className="min-w-0 truncate text-caption text-ink-2">{turn.userText}</span>
                    <TurnLocateControl
                      target={locateTargetOf(turn.id)}
                      onLocate={onLocateMessage}
                    />
                    <span
                      className={cn(
                        "ml-auto flex shrink-0 items-center gap-1 text-micro",
                        turnStatusTextClass(outcome.dot),
                      )}
                      title={outcome.title}
                    >
                      {outcome.dot && (
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            statusDotClass(outcome.dot),
                          )}
                        />
                      )}
                      <span className="truncate">{outcome.label}</span>
                    </span>
                  </div>
                  {rows.map((a) => (
                    <ActivityListRow
                      key={a.id}
                      activity={a}
                      player={players.find((x) => x.id === a.playerId)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {view === "graph" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 && (
            <div className="px-4 py-10 text-center text-caption leading-relaxed text-ink-3">
              这个会话还没有轨迹
              <br />
              <span className="text-micro">@ 一个玩家开始</span>
            </div>
          )}
          <div className="flex">
            <svg width={svgWidth} height={height} className="shrink-0">
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
              {rows.map((r) => (
                <GraphLabelRow
                  key={`${r.id}:${r.id === focusId ? focusTick : 0}`}
                  row={r}
                  focusId={focusId}
                  register={(id, el) => {
                    if (el) rowRefs.current.set(id, el);
                    else rowRefs.current.delete(id);
                  }}
                  registerTurn={registerTurn}
                  locateOf={locateTargetOf}
                  onLocate={onLocateMessage}
                />
              ))}
            </div>
          </div>
        </div>
        )}

        <footer className="shrink-0 border-t border-line-1/60 px-3 py-2 text-micro leading-relaxed text-ink-3">
          {resumeGap !== null && resumeGap > 0 && (
            <div className="mb-1 text-warn-1">恢复后可能丢了 {resumeGap} 条事件（事件水位断档）</div>
          )}
          主干是你的时间轴；一轮里被 @ 的玩家各开一条支线并行跑，答完弯回主干，虚线头表示还在答。
        </footer>
      </div>
    </div>
  );
}
