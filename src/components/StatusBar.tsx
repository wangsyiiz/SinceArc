import { useState, type ReactNode } from "react";
import { ChevronDown, Waypoints } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentProfile, SessionResumeState } from "@/types";
import { cn } from "@/lib/utils";
import { profileLabel } from "@/lib/format";
import { localizeText } from "@/lib/i18n-text";
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
  const { t } = useTranslation();
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
      <Tooltip
        label={traceOpen ? t("statusbar.trace.collapse") : t("statusbar.trace.expand")}
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleTrace}
          aria-label={traceOpen ? t("statusbar.trace.collapse") : t("statusbar.trace.expand")}
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
  const { t } = useTranslation();
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
          ? t("statusbar.resume.unavailable", {
              reason: resume.reason ?? t("statusbar.resume.unknownReason"),
            })
          : resume.note
            ? t("statusbar.resume.resumedWithNote", {
                id: resume.acpSessionId.slice(0, 12),
              })
            : t("statusbar.resume.resumed", { id: resume.acpSessionId.slice(0, 12) })}
      </span>
      {hover.card(
        <div>
          <div className="break-all font-mono text-caption text-ink-1">
            {t("statusbar.resume.resumed", { id: resume.acpSessionId })}
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
  const { t } = useTranslation();
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard();
  return (
    <>
      <span
        ref={setEl}
        {...hover.triggerProps(el)}
        className="mr-1 font-mono text-micro text-ink-3"
      >
        {t("statusbar.sessionShort", { id: sessionId.slice(0, 8) })}
      </span>
      {hover.card(
        <span className="break-all font-mono">
          {t("statusbar.sessionTag", { id: sessionId })}
        </span>,
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
  const { t } = useTranslation();
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard();
  return (
    <>
      <span
        ref={setEl}
        {...hover.triggerProps(el)}
        className="mr-1 max-w-40 truncate font-mono text-micro text-ink-3"
      >
        {lastEvent
          ? t("statusbar.events.shortWithLast", { eventCount, lastEvent })
          : t("statusbar.events.short", { eventCount })}
      </span>
      {hover.card(
        <div>
          <div>{t("statusbar.events.received", { eventCount })}</div>
          <div className="mt-1 break-all font-mono text-caption text-ink-2">
            {t("statusbar.events.last", { lastEvent: lastEvent ?? "-" })}
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
  const { t } = useTranslation();
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard();
  const detail = connectError
    ? t("statusbar.profile.connectError", {
        code: connectError.code,
        message: localizeText(connectError.message, t),
      })
    : profile.connected
      ? t("statusbar.profile.connected", {
          agent: profile.agentName ?? "agent",
          version: profile.protocolVersion ?? 1,
        })
      : connecting
        ? t("statusbar.profile.connecting")
        : t("statusbar.profile.disconnected");

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
              ? t("statusbar.profile.statusFailed")
              : profile.connected
                ? t("statusbar.profile.statusConnected")
                : connecting
                  ? t("statusbar.profile.statusConnecting")
                  : t("statusbar.profile.statusDisconnected")
          }
        />
      </span>
      {hover.card(<div className="break-words text-caption text-ink-2">{detail}</div>)}
    </>
  );
}
