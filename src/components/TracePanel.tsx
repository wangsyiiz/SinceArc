import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlignLeft, FileText, PencilLine, Play, Search, SendHorizontal, Sparkles, ShieldAlert, ShieldCheck, ShieldX, Waypoints, X } from "lucide-react";
import type { Activity, ActivityKind, Player, TraceTurn } from "@/types";
import type { TraceBackfillDto } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { isTurnCancelled } from "@/lib/turn-status";
import { turnHeading, turnLabel } from "@/lib/turn-summary";
import { useVirtualList } from "@/lib/virtual/useVirtualList";
import type { LocateTarget } from "@/lib/turn-anchors";
import { Button } from "./ui/Button";
import { useHoverCard } from "./ui/HoverCard";
import { Tooltip } from "./ui/Tooltip";
import { RemovedBadge } from "./RemovedBadge";

const ROW = 34;
/** 图视图的活动上限：超过就只剩列表（§19.6，4 万节点会卡死）。 */
const TRACE_GRAPH_MAX_ACTIVITIES = 1500;
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
  /** 轮抬头专用：行内短标签「第 N 轮」；title 里是完整摘要。 */
  turnLabel?: string;
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

  for (const [index, t] of turns.entries()) {
    const p0 = players.find((x) => x.id === t.branches[0]?.playerId);
    const outcome = turnOutcome(t);
    const heading = turnHeading(t, index, outcome.label);

    rows.push({
      id: `${t.id}-user`,
      x: MAIN_X,
      y,
      kind: "user",
      title: heading,
      turnLabel: turnLabel(index),
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

function backfillResultText(result: TraceBackfillDto): string {
  let text =
    result.captured === 0
      ? "agent 没有重放出轨迹事件。"
      : result.added === 0 && result.skipped > 0
        ? `没有新轨迹（${result.skipped} 条重复已跳过）。`
        : `已补录 ${result.added} 条轨迹，跳过重复 ${result.skipped} 条。`;
  if (result.timedOut) {
    text += "（重放超时，已按收到的部分补录）";
  }
  return text;
}

function HoverContent({ row }: { row: TraceRow }) {
  const activity = row.activity;
  const Icon = activityIcon(activity);

  /* 抬头是「这是什么」，正文是「内容」—— 两者别混。
     思考条目的 title 在列表里被切成 42 字（列表宽度决定），如果照搬到卡片抬头，
     看起来就像卡片里的内容也被截了；所以抬头只写「思考」，全文进正文（后端保留 8KB，含换行）。 */
  const headline =
    row.kind === "user"
      ? "这一轮"
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
        className={cn(
          "flex items-center gap-1.5 rounded-mark pr-2 transition-colors hover:bg-surface-2/50",
          r.id === focusId && "sc-row-fade",
          r.kind === "reply" ? "text-ink-1" : "text-ink-2",
        )}
      >
        {r.kind === "user" ? (
          <>
            <span className="shrink-0 font-mono text-micro text-ink-3">{r.at}</span>
            <span className="min-w-0 truncate text-caption text-ink-3">
              {r.turnLabel ?? r.title}
            </span>
            <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
              <TurnLocateControl target={locateOf(r.turnId ?? "")} onLocate={onLocate} />
              {r.statusLabel && (
                <span
                  className={cn(
                    "flex shrink-0 items-center gap-1 text-micro",
                    turnStatusTextClass(r.status),
                  )}
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

function TurnListHeader({
  heading,
  outcome,
  at,
  label,
  target,
  onLocate,
}: {
  heading: string;
  outcome: { label: string; dot?: TraceRow["status"]; title?: string };
  at: string;
  label: string;
  target: LocateTarget;
  onLocate: (messageId: string) => void;
}) {
  const [headingEl, setHeadingEl] = useState<HTMLSpanElement | null>(null);
  const [statusEl, setStatusEl] = useState<HTMLSpanElement | null>(null);
  const headingHover = useHoverCard();
  const statusHover = useHoverCard({ disabled: !outcome.title });

  return (
    <>
      <div className="flex items-center gap-1.5 px-1 py-1">
        <span className="shrink-0 font-mono text-micro text-ink-3">{at}</span>
        <span
          ref={setHeadingEl}
          {...headingHover.triggerProps(headingEl)}
          className="min-w-0 truncate text-caption text-ink-3"
        >
          {label}
        </span>
        <TurnLocateControl target={target} onLocate={onLocate} />
        <span
          ref={setStatusEl}
          {...statusHover.triggerProps(statusEl)}
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 text-micro",
            turnStatusTextClass(outcome.dot),
          )}
        >
          {outcome.dot && (
            <span
              className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(outcome.dot))}
            />
          )}
          <span className="truncate">{outcome.label}</span>
        </span>
      </div>
      {headingHover.card(
        <div className="break-words text-caption text-ink-2">{heading}</div>,
      )}
      {statusHover.card(
        <div className="break-words text-caption text-ink-2">{outcome.title}</div>,
      )}
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
  backfill?: {
    canRun: boolean;
    running: boolean;
    result: TraceBackfillDto | null;
    /** 命令失败原因（50300 = 连接已断）；有它就代替结果行显示 */
    error: string | null;
    onRun: () => void;
  };
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
  backfill,
}: TracePanelProps) {
  const [backfillEl, setBackfillEl] = useState<HTMLButtonElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const turnRefs = useRef(new Map<string, HTMLDivElement>());
  const backfillHover = useHoverCard({ disabled: !backfill?.canRun || backfill.running });
  // 图视图的布局只在真正要画图时算：4 万活动全量算一遍要好几秒，
  // 而列表视图 + 超阈值（图被禁用）时这份计算纯属浪费（真机：打开 11.6s 里有大头在这儿）。
  const [view, setView] = useState<"graph" | "list">("graph");
  const graphTooHeavy = activities.length > TRACE_GRAPH_MAX_ACTIVITIES;
  const graphWanted = view === "graph" && !graphTooHeavy;
  const { rows, edges, height, width: svgWidth } = useMemo(
    () =>
      graphWanted
        ? buildTrace(turns, activities, players)
        : { rows: [], edges: [], height: 0, width: 0 },
    [graphWanted, turns, activities, players],
  );

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

  // 列表视图虚拟化（§19.6）：把「轮标题 + 该轮活动行」拍平成一维 items。
  // 图视图每个活动一个 SVG 节点，活动一多必然卡死，所以超过阈值时禁用图视图。
  const playersById = useMemo(() => new Map(players.map((x) => [x.id, x])), [players]);

  const listItems = useMemo(() => {
    const items: Array<
      { kind: "turn"; turn: TraceTurn; index: number } | { kind: "activity"; activity: Activity }
    > = [];
    listGroups.forEach(({ turn, activities: rows }, index) => {
      items.push({ kind: "turn", turn, index });
      for (const activity of rows) items.push({ kind: "activity", activity });
    });
    return items;
  }, [listGroups]);

  const listScrollRef = useRef<HTMLDivElement | null>(null);
  // 这两个回调必须稳定：每次渲染换新函数会让虚拟化库以为「估算规则变了」，
  // 于是每帧重算全部条目 —— 真机 4 万条时滚动 p50 从 10ms 涨到 22ms 就是它。
  const estimateListItem = useCallback(
    (index: number) => (listItems[index]?.kind === "turn" ? 44 : 36),
    [listItems],
  );
  const listKeyOf = useCallback(
    (index: number) => {
      const item = listItems[index];
      if (!item) return `x:${index}`;
      return item.kind === "turn" ? `t:${item.turn.id}` : `a:${item.activity.id}`;
    },
    [listItems],
  );
  const {
    rows: virtualListRows,
    totalSize: listTotalSize,
    measureRow: measureListRow,
    scrollToIndex: scrollListToIndex,
  } = useVirtualList({
    count: listItems.length,
    keyOf: listKeyOf,
    estimate: estimateListItem,
    scrollRef: listScrollRef,
  });

  const indexOfTurn = (turnId: string) =>
    listItems.findIndex((item) => item.kind === "turn" && item.turn.id === turnId);
  const indexOfActivity = (activityId: string) =>
    listItems.findIndex((item) => item.kind === "activity" && item.activity.id === activityId);

  useEffect(() => {
    if (graphTooHeavy && view === "graph") setView("list");
  }, [graphTooHeavy, view]);

  useEffect(() => {
    if (!open || !focusId) return;
    if (view === "list") {
      const index = indexOfActivity(focusId);
      if (index >= 0) scrollListToIndex(index, "center");
      return;
    }
    const el = rowRefs.current.get(focusId);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [open, focusId, focusTick, view, listItems, scrollListToIndex]);

  useEffect(() => {
    if (!open || !locateTurnId) return;
    if (view === "list") {
      const index = indexOfTurn(locateTurnId);
      if (index >= 0) scrollListToIndex(index, "center");
      return;
    }
    const el = turnRefs.current.get(locateTurnId);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [open, locateTurnId, locateTick, turns, view, listItems, scrollListToIndex]);

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
            <Tooltip label={graphTooHeavy ? "图形（轨迹过多，已省略）" : "图形"}>
              <button
                type="button"
                aria-label="图形"
                aria-disabled={graphTooHeavy}
                disabled={graphTooHeavy}
                onClick={() => setView("graph")}
                className={cn(
                  "grid size-5 place-items-center rounded-mark transition-colors",
                  view === "graph" ? "bg-surface-3/85 text-ink-1" : "text-ink-3 hover:text-ink-2",
                  graphTooHeavy && "cursor-not-allowed opacity-40 hover:text-ink-3",
                )}
              >
                <Waypoints className="size-3" />
              </button>
            </Tooltip>
            <Tooltip label="列表">
              <button
                type="button"
                aria-label="列表"
                onClick={() => setView("list")}
                className={cn(
                  "grid size-5 place-items-center rounded-mark transition-colors",
                  view === "list" ? "bg-surface-3/85 text-ink-1" : "text-ink-3 hover:text-ink-2",
                )}
              >
                <AlignLeft className="size-3" />
              </button>
            </Tooltip>
          </div>
          {backfill && (
            <button
              ref={setBackfillEl}
              {...backfillHover.triggerProps(backfillEl)}
              type="button"
              onClick={backfill.onRun}
              disabled={!backfill.canRun || backfill.running}
              className="ml-1 shrink-0 rounded-mark px-1.5 py-1 text-caption text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-45"
            >
              补录
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-1 grid size-6 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-1"
          >
            <X className="size-3.5" />
          </button>
        </header>

        {/* design-language §11：主动截断/清理的数据必须在界面上讲清楚，否则看起来像 bug */}
        <div className="shrink-0 border-b border-line-1/40 px-3 py-1 text-micro leading-relaxed text-ink-3">
          思考过程只保留开头 8KB；轨迹超过 5 万条或 90 天会在消息流末尾提示，不会自动删除。
        </div>

        {graphTooHeavy && (
          <div className="shrink-0 border-b border-line-1/40 px-3 py-1 text-caption text-ink-3">
            轨迹过多（{actionCount} 条活动），图视图已省略，只能在列表里看。
          </div>
        )}

        {backfill?.error && (
          <div className="shrink-0 border-b border-line-1/40 px-3 py-1 text-caption text-danger-1">
            {backfill.error}
          </div>
        )}

        {backfill?.result && (
          <div className="shrink-0 border-b border-line-1/40 px-3 py-1 text-caption text-ink-3">
            {backfillResultText(backfill.result)}
          </div>
        )}

        {view === "list" && (
          <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
            {turns.length === 0 ? (
              <div className="py-8 text-center text-caption text-ink-3">没有活动</div>
            ) : (
              <div className="relative" style={{ height: listTotalSize }}>
                {virtualListRows.map((row) => {
                  const item = listItems[row.index];
                  if (!item) return null;
                  return (
                    <div
                      key={row.key}
                      ref={measureListRow}
                      data-index={row.index}
                      data-turn-id={item.kind === "turn" ? item.turn.id : undefined}
                      data-activity-id={item.kind === "activity" ? item.activity.id : undefined}
                      className="absolute inset-x-0 top-0 pb-1"
                      style={{
                        transform: `translateY(${row.start}px)`,
                        minHeight: estimateListItem(row.index),
                      }}
                    >
                      {item.kind === "turn" ? (
                        <TurnListHeader
                          heading={turnHeading(item.turn, item.index, turnOutcome(item.turn).label)}
                          outcome={turnOutcome(item.turn)}
                          at={item.turn.at}
                          label={turnLabel(item.index)}
                          target={locateTargetOf(item.turn.id)}
                          onLocate={onLocateMessage}
                        />
                      ) : (
                        <ActivityListRow
                          activity={item.activity}
                          player={item.activity.playerId ? playersById.get(item.activity.playerId) : undefined}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
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

        {backfill &&
          backfillHover.card(
            <div className="space-y-1">
              <p className="text-caption font-medium text-ink-1">补录轨迹</p>
              <p>从 agent 重放补全本会话轨迹。只补轨迹，不动正文。</p>
            </div>,
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
