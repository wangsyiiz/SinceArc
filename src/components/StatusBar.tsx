import { useState, type ReactNode } from "react";
import { ChevronDown, Waypoints } from "lucide-react";
import type { AgentProfile, SessionResumeState } from "@/types";
import { cn } from "@/lib/utils";
import { profileLabel } from "@/lib/format";
import { ModeSelect } from "@/components/ModeSelect";
import { DiagnosticsPanel } from "@/components/DiagnosticsPanel";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { useHoverCard } from "./ui/HoverCard";
import { Tooltip } from "./ui/Tooltip";
import type { ModeView } from "@/hooks/useSessionModes";

interface StatusBarProps {
  cwd: string;
  profile: AgentProfile | undefined;
  traceOpen: boolean;
  onToggleTrace: () => void;
  /** 这条界面会话自己的 ACP 会话 id（不是「连接当前会话」，见 docs/data-plane.md §2） */
  sessionId?: string;
  /** 调试用：累计收到的 inbound 事件数与其方法名 */
  eventCount?: number;
  lastEvent?: string;
  /** 诊断浮层的事件流；已经在别处截断到最近 80 条 */
  eventLog?: { at: number; text: string }[];
  /** 当前会话的审批模式；为空时状态栏不显示选择器 */
  modes?: ModeView | null;
  onChooseMode?: (modeId: string | null) => void;
  /** 跟随连接默认时，副标题显示哪个模式；由上层查 profile 后传入 */
  fallbackLabel?: string | null;
  /** 右侧插槽：agent 能力入口等 */
  right?: ReactNode;
  /** 最近一次会话恢复判定；无标记表示新会话/尚未恢复 */
  resume?: SessionResumeState | null;
  /** 最近一次连接尝试失败；用来区分“未连接”和“连接失败” */
  connectError?: { code: string; message: string } | null;
  /** 正在为这个会话连（无感连接 / 手动重试）：让「打开到可用」这一段也有可见的过渡 */
  connecting?: boolean;
}

export function StatusBar({
  cwd,
  profile,
  traceOpen,
  onToggleTrace,
  sessionId,
  eventCount = 0,
  lastEvent,
  eventLog = [],
  modes,
  onChooseMode,
  fallbackLabel,
  right,
  resume,
  connectError,
  connecting = false,
}: StatusBarProps) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
      <Tooltip label={traceOpen ? "收起轨迹" : "展开轨迹"}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleTrace}
          aria-label={traceOpen ? "收起轨迹" : "展开轨迹"}
          className={cn(
            "size-7 shrink-0 gap-0 rounded-mark p-0",
            traceOpen ? "bg-surface-3/65 text-ink-1" : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
          )}
        >
          <Waypoints className="size-3.5" />
        </Button>
      </Tooltip>

      <DiagnosticsPanel eventLog={eventLog} />

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
        {resume && <ResumeStatus resume={resume} />}
        {sessionId && <SessionTag sessionId={sessionId} />}
        {eventCount > 0 && <EventStats eventCount={eventCount} lastEvent={lastEvent} />}
        {profile && (
          <ProfileStatus
            profile={profile}
            connectError={connectError}
            connecting={connecting}
          />
        )}

      </div>
    </header>
  );
}

function ResumeStatus({ resume }: { resume: SessionResumeState }) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard({ disabled: resume.kind !== "resumed" });
  return (
    <>
      <span
        ref={setEl}
        {...hover.triggerProps(el)}
        className={cn(
          "mr-1 max-w-60 truncate text-micro",
          resume.kind === "unavailable" ? "text-warn-1" : "text-ink-3",
        )}
      >
        {resume.kind === "unavailable"
          ? `续不上：${resume.reason ?? "原因不明"}`
          : `续上（${resume.acpSessionId.slice(0, 12)}）${resume.note ? " · 注意" : ""}`}
      </span>
      {hover.card(
        <div>
          <div className="break-all font-mono text-caption text-ink-1">
            续上（{resume.acpSessionId}）
          </div>
          {resume.note && (
            <div className="mt-1 break-words text-caption text-ink-2">{resume.note}</div>
          )}
        </div>,
      )}
    </>
  );
}

function SessionTag({ sessionId }: { sessionId: string }) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard();
  return (
    <>
      <span
        ref={setEl}
        {...hover.triggerProps(el)}
        className="mr-1 font-mono text-micro text-ink-3"
      >
        s:{sessionId.slice(0, 8)}
      </span>
      {hover.card(
        <span className="break-all font-mono">session {sessionId}</span>,
      )}
    </>
  );
}

function EventStats({
  eventCount,
  lastEvent,
}: {
  eventCount: number;
  lastEvent?: string;
}) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard();
  return (
    <>
      <span
        ref={setEl}
        {...hover.triggerProps(el)}
        className="mr-1 max-w-40 truncate font-mono text-micro text-ink-3"
      >
        ev {eventCount}
        {lastEvent ? ` · ${lastEvent}` : ""}
      </span>
      {hover.card(
        <div>
          <div>收到的 ACP 事件：{eventCount}</div>
          <div className="mt-1 break-all font-mono text-caption text-ink-2">
            最后一条：{lastEvent ?? "-"}
          </div>
        </div>,
      )}
    </>
  );
}

function ProfileStatus({
  profile,
  connectError,
  connecting,
}: {
  profile: AgentProfile;
  connectError: StatusBarProps["connectError"];
  connecting: boolean;
}) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard();
  const detail = connectError
    ? `连接失败：${connectError.code} ${connectError.message}`
    : profile.connected
      ? `${profile.agentName ?? "agent"} · 协议 v${profile.protocolVersion ?? 1}`
      : connecting
        ? "正在连接 agent…"
        : "这个会话还没有连上 agent（打开会话会自动连）";

  return (
    <>
      <span
        ref={setEl}
        {...hover.triggerProps(el)}
        className="mr-1 flex min-w-0 items-center gap-1.5"
      >
        <span className="max-w-30 truncate text-caption text-ink-2">{profileLabel(profile)}</span>
        <Badge
          compact
          status={
            connectError
              ? "error"
              : profile.connected
                ? "connected"
                : connecting
                  ? "connecting"
                  : "untested"
          }
          label={
            connectError
              ? "连接失败"
              : profile.connected
                ? "已连接"
                : connecting
                  ? "连接中…"
                  : "未连接"
          }
        />
      </span>
      {hover.card(<div className="break-words text-caption text-ink-2">{detail}</div>)}
    </>
  );
}
