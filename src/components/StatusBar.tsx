import type { ReactNode } from "react";
import { ChevronDown, Waypoints } from "lucide-react";
import type { AgentProfile } from "@/types";
import { cn } from "@/lib/utils";
import { profileLabel } from "@/lib/format";
import { ModeSelect } from "@/components/ModeSelect";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
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
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleTrace}
        title={traceOpen ? "收起轨迹" : "展开轨迹"}
        aria-label={traceOpen ? "收起轨迹" : "展开轨迹"}
        className={cn(
          "size-7 shrink-0 gap-0 rounded-mark p-0",
          traceOpen ? "bg-surface-3/65 text-ink-1" : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <Waypoints className="size-3.5" />
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="h-auto min-w-0 justify-start gap-1.5 rounded-mark px-1.5 py-1 font-mono text-caption font-normal"
      >
        <span className="truncate">{cwd}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-3" />
      </Button>

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
            className="mr-1 font-mono text-micro text-ink-3"
            title={`session ${sessionId}`}
          >
            s:{sessionId.slice(0, 8)}
          </span>
        )}
        {eventCount > 0 && (
          <span
            className="mr-1 max-w-40 truncate font-mono text-micro text-ink-3"
            title={`收到的 ACP 事件：${eventCount}，最后一条 ${lastEvent ?? "-"}`}
          >
            ev {eventCount}
            {lastEvent ? ` · ${lastEvent}` : ""}
          </span>
        )}
        {profile && (
          <span
            className="mr-1 flex min-w-0 items-center gap-1.5"
            title={
              profile.connected
                ? `${profile.agentName ?? "agent"} · 协议 v${profile.protocolVersion ?? 1}`
                : "这个会话还没有连上 agent（打开会话会自动连）"
            }
          >
            <span className="max-w-30 truncate text-caption text-ink-2">{profileLabel(profile)}</span>
            <Badge
              compact
              status={profile.connected ? "connected" : "untested"}
              label={profile.connected ? "已连接" : "未连接"}
            />
          </span>
        )}

      </div>
    </header>
  );
}
