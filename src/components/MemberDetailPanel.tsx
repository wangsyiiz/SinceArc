import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  Eye,
  FolderOpen,
  Hash,
  Layers,
  Plug,
  SendHorizontal,
  UserMinus,
} from "lucide-react";
import { asCmdError, type AgentUser } from "@/lib/ipc";
import { agentBrand } from "@/lib/agent-brands";
import { delegateCapsLabel, delegateTargetCaps } from "@/lib/delegate-target";
import { profileLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgentProfile } from "@/types";
import { AgentLogo } from "./AgentLogo";
import { Tooltip } from "./ui/Tooltip";

const ANCHOR_GAP = 8;
const VIEWPORT_MARGIN = 8;
const ACTION_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-mark px-2 text-caption transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1";

function DetailRow({
  label,
  value,
  icon,
  before,
  mono = false,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  before?: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 shrink-0 text-ink-3">{icon}</span>
      <span className="shrink-0 text-caption text-ink-3">{label}</span>
      <span
        className={cn(
          "flex min-w-0 flex-1 items-start justify-end gap-1.5 text-right text-caption text-ink-2",
          mono && "font-mono",
        )}
      >
        {before}
        <span className="min-w-0 break-all">{value}</span>
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
  }, [anchor, error, member.id, member.acpSessionId, profile]);

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
  const logoAgent = profile
    ? ([profile.agentName, profile.program, profileLabel(profile)].find(
        (candidate): candidate is string => !!candidate && agentBrand(candidate) !== null,
      ) ?? profileLabel(profile))
    : null;
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
        width: "max-content",
        minWidth: 240,
        maxWidth: 380,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <Tooltip label={member.name}>
        <div className="min-w-0 truncate pr-1 text-ui text-ink-1">{member.name}</div>
      </Tooltip>

      {/* 分割线用 1px 色块，不用 border：浮层里手写边框会多套一圈（见 design-language） */}
      <div className="my-2 h-px bg-line-1/60" />

      <div className="space-y-1.5">
        <DetailRow icon={<AtSign size={13} />} label="@短名" value={`@${member.handle}`} />
        <DetailRow
          icon={<Plug size={13} />}
          label="连接"
          value={connection}
          before={<AgentLogo agent={logoAgent} size={14} />}
        />
        <DetailRow icon={<Hash size={13} />} label="ACP 会话" value={member.acpSessionId} mono />
        <DetailRow icon={<FolderOpen size={13} />} label="工作目录" value={workDir} />
        <DetailRow
          icon={<Layers size={13} />}
          label="派活档位"
          value={delegateCapsLabel(delegateTargetCaps(profile))}
        />
      </div>

      <div className="mt-2.5 h-px bg-line-1/60" />

      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          aria-label="派活"
          onClick={onDelegate}
          className={cn(ACTION_CLASS, "text-ink-3 hover:bg-surface-3/55 hover:text-ink-1")}
        >
          <SendHorizontal size={13} />
          <span>派活</span>
        </button>
        <button
          type="button"
          aria-label="只看 TA"
          aria-pressed={filtered}
          onClick={onFilter}
          className={cn(
            ACTION_CLASS,
            filtered
              ? "bg-surface-3/60 text-ink-1"
              : "text-ink-3 hover:bg-surface-3/55 hover:text-ink-1",
          )}
        >
          <Eye size={13} />
          <span>只看 TA</span>
        </button>
        <button
          type="button"
          aria-label="移出群"
          disabled={removing}
          onClick={() => void remove()}
          className={cn(
            ACTION_CLASS,
            "ml-auto text-ink-3 hover:bg-surface-3/55 hover:text-ink-1 disabled:cursor-not-allowed disabled:opacity-45",
          )}
        >
          <UserMinus size={13} />
          <span>移出群</span>
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
