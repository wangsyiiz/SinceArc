import type { ReactNode } from "react";
import { ChevronDown, ShieldCheck, Waypoints } from "lucide-react";
import type { AgentProfile } from "@/types";
import { cn } from "@/lib/utils";
import { ModeSelect } from "@/components/ModeSelect";
import type { ModeView } from "@/hooks/useSessionModes";

interface StatusBarProps {
  cwd: string;
  profile: AgentProfile | undefined;
  traceOpen: boolean;
  onToggleTrace: () => void;
  /** 当前 profile 的会话 id（握手后建出来的那个） */
  sessionId?: string;
  /** 调试用：累计收到的 inbound 事件数与其方法名 */
  eventCount?: number;
  lastEvent?: string;
  /** 当前会话的审批模式；为空时状态栏不显示选择器 */
  modes?: ModeView | null;
  onChooseMode?: (modeId: string | null) => void;
  /** 跟随连接默认时，副标题显示哪个模式；由上层查 profile 后传入 */
  fallbackLabel?: string | null;
  /** 右侧插槽：agent 能力入口等 */
  right?: ReactNode;
}

export function StatusBar({
  cwd,
  profile,
  traceOpen,
  onToggleTrace,
  sessionId,
  eventCount = 0,
  lastEvent,
  modes,
  onChooseMode,
  fallbackLabel,
  right,
}: StatusBarProps) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
      <button
        onClick={onToggleTrace}
        title={traceOpen ? "收起轨迹" : "展开轨迹"}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-[6px] transition-colors",
          traceOpen ? "bg-surface-3/65 text-ink-1" : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <Waypoints className="size-3.5" />
      </button>

      <button className="flex min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 py-1 font-mono text-[11px] text-ink-2 transition-colors hover:bg-surface-3/35 hover:text-ink-1">
        <span className="truncate">{cwd}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-3" />
      </button>

      <div className="ml-auto flex items-center gap-0.5">
        {modes && onChooseMode && (
          <ModeSelect
            compact
            current={modes.current}
            available={modes.available}
            following={modes.following}
            fallbackLabel={fallbackLabel}
            warning={modes.warning}
            onChoose={onChooseMode}
          />
        )}
        {right}
        {sessionId && (
          <span
            className="mr-1 font-mono text-[9px] text-ink-3"
            title={`session ${sessionId}`}
          >
            s:{sessionId.slice(0, 8)}
          </span>
        )}
        {eventCount > 0 && (
          <span
            className="mr-1 max-w-[160px] truncate font-mono text-[9px] text-ink-3"
            title={`收到的 ACP 事件：${eventCount}，最后一条 ${lastEvent ?? "-"}`}
          >
            ev {eventCount}
            {lastEvent ? ` · ${lastEvent}` : ""}
          </span>
        )}
        {profile && (
          <div
            className={cn(
              "mr-1 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]",
              profile.connected
                ? "border-ok-1/20 bg-ok-1/[0.08] text-ok-1"
                : "border-line-1 bg-surface-2/50 text-ink-3",
            )}
          >
            <ShieldCheck className="size-2.5" />
            {profile.connected ? `${profile.agentName ?? "已连接"} · v${profile.protocolVersion ?? 1}` : "未连接"}
          </div>
        )}

      </div>
    </header>
  );
}
