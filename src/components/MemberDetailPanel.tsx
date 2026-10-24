import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Eye, SendHorizontal, UserMinus } from "lucide-react";
import { asCmdError, type AgentUser } from "@/lib/ipc";
import { delegateCapsLabel, delegateTargetCaps } from "@/lib/delegate-target";
import { profileLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgentProfile } from "@/types";

const PANEL_WIDTH = 260;
const ANCHOR_GAP = 8;
const VIEWPORT_MARGIN = 8;

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <span className="shrink-0 text-caption text-ink-3">{label}</span>
      <span
        className={cn("min-w-0 flex-1 truncate text-right text-caption text-ink-2", mono && "font-mono")}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

export function MemberDetailPanel({
  member,
  profile,
  anchor,
  onClose,
  onDelegate,
  onFilter,
  filtered,
  onRemove,
}: {
  member: AgentUser;
  profile: AgentProfile | undefined;
  anchor: HTMLElement | null;
  onClose: () => void;
  onDelegate: () => void;
  onFilter: () => void;
  filtered: boolean;
  onRemove: () => Promise<void>;
}) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setPos(null);
      return;
    }
    const a = anchor.getBoundingClientRect();
    const p = panelRef.current?.getBoundingClientRect();
    if (!p) return;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(a.right + ANCHOR_GAP, window.innerWidth - p.width - VIEWPORT_MARGIN),
    );
    const centered = a.top + a.height / 2 - p.height / 2;
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(centered, window.innerHeight - p.height - VIEWPORT_MARGIN),
    );
    setPos({ left, top });
  }, [anchor, error, member.id]);

  useEffect(() => {
    setError(null);
    setRemoving(false);
  }, [member.id]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onMove = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;

  const connection = profile ? profileLabel(profile) : "连接已不在";
  const workDir = profile?.cwd?.trim() || "—";

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    try {
      await onRemove();
      onClose();
    } catch (e) {
      setError(asCmdError(e).msg);
    } finally {
      setRemoving(false);
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${member.name} 的详情`}
      className="sc-glass fixed sc-z-popover rounded-control p-2.5 text-ink-1"
      style={{
        width: PANEL_WIDTH,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="mb-2 min-w-0 truncate text-ui text-ink-1" title={member.name}>
        {member.name}
      </div>

      <div className="space-y-1.5">
        <DetailRow label="@短名" value={`@${member.handle}`} />
        <DetailRow label="连接" value={connection} />
        <DetailRow label="连接 id" value={member.profileId} />
        <DetailRow label="ACP 会话" value={member.acpSessionId} mono />
        <DetailRow label="工作目录" value={workDir} />
        <DetailRow label="派活档位" value={delegateCapsLabel(delegateTargetCaps(profile))} />
      </div>

      <div className="mt-2.5 flex items-center gap-1">
        <button
          type="button"
          title="派活…"
          aria-label="派活…"
          onClick={onDelegate}
          className="grid size-7 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
        >
          <SendHorizontal size={13} />
        </button>
        <button
          type="button"
          title="只看 TA"
          aria-label="只看 TA"
          aria-pressed={filtered}
          onClick={onFilter}
          className={cn(
            "grid size-7 place-items-center rounded-mark transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
            filtered
              ? "bg-surface-3/60 text-ink-1"
              : "text-ink-3 hover:bg-surface-3/55 hover:text-ink-1",
          )}
        >
          <Eye size={13} />
        </button>
        <button
          type="button"
          title="移出群"
          aria-label="移出群"
          disabled={removing}
          onClick={() => void remove()}
          className="ml-auto grid size-7 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3/55 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <UserMinus size={13} />
        </button>
      </div>

      {error && (
        <p className="mt-2 break-all text-caption text-danger-1" role="alert">
          {error}
        </p>
      )}
    </div>,
    document.body,
  );
}
